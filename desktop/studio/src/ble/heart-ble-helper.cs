/*
 * CertiFried Studio: Bluetooth LE heart-rate helper (Studio 0.2.14).
 *
 * The same approach as govee-ble-helper.cs: Windows' own WinRT Bluetooth API with the normal driver, built with the .NET
 * Framework C# compiler by scripts/build-ble-helper.ps1, started by src/main/heart-rate.js. It reads any device that
 * follows the Bluetooth SIG Heart Rate Service: a chest strap, a Garmin with "Broadcast heart rate", or a Wear OS watch
 * running an app such as Heart for Bluetooth. It never writes to the device apart from switching notifications on, and it
 * makes no network connections.
 *
 * Protocol: one JSON object per line on stdin, one per line on stdout.
 *   { id, op: 'scan', ms, all }      → { id, ok, devices: [{ address, name, rssi, hr }] }
 *                                      hr: the advertisement lists the Heart Rate Service (0x180D). Without `all` only those.
 *   { id, op: 'connect', address }   → { id, ok, name, battery }   subscribes to Heart Rate Measurement (0x2A37) notifications
 *   { id, op: 'disconnect' }         → { id, ok }
 *   events: { type: 'ready' } | { type: 'hr', address, hex } (each 0x2A37 notification, raw bytes)
 *           | { type: 'battery', address, percent } | { type: 'link', address, connected } | { type: 'log', message }
 * Errors: { id, ok: false, error: code, message }. Codes: not_found, no_service, access_denied, timeout, bad_params,
 * no_adapter, failed.
 *
 * GATT (Bluetooth SIG assigned numbers): Heart Rate service 0x180D, Heart Rate Measurement 0x2A37 (notify),
 * Battery service 0x180F, Battery Level 0x2A19 (read, sometimes notify). One device at a time.
 */
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Enumeration;

public static class HeartBleHelper {
    static readonly Guid HrService = BluetoothUuidHelper.FromShortId(0x180D);
    static readonly Guid HrMeasurement = BluetoothUuidHelper.FromShortId(0x2A37);
    static readonly Guid BatteryService = BluetoothUuidHelper.FromShortId(0x180F);
    static readonly Guid BatteryLevel = BluetoothUuidHelper.FromShortId(0x2A19);
    static readonly object OutLock = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly SemaphoreSlim Gate = new SemaphoreSlim(1, 1);

    static BluetoothLEDevice Device;
    static GattCharacteristic Measurement;
    static GattCharacteristic Battery;
    static ulong Address;

    static void Send(Dictionary<string, object> o) {
        var s = Json.Serialize(o);
        lock (OutLock) { Console.Out.WriteLine(s); Console.Out.Flush(); }
    }
    static Dictionary<string, object> Obj(params object[] kv) {
        var d = new Dictionary<string, object>();
        for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        return d;
    }
    static void Log(string m) { Send(Obj("type", "log", "message", m)); }
    static string AddrText(ulong a) { return a.ToString("X12"); }
    static ulong ParseAddr(object v) {
        var s = (v as string ?? "").Replace(":", "").Replace("-", "").Trim();
        if (s.Length != 12) throw new ArgumentException("bad_params");
        return Convert.ToUInt64(s, 16);
    }
    static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }

    static async Task<List<Dictionary<string, object>>> Scan(int ms, bool all) {
        var seen = new Dictionary<ulong, Dictionary<string, object>>();
        var w = new BluetoothLEAdvertisementWatcher();
        w.ScanningMode = BluetoothLEScanningMode.Active;
        w.Received += (s, a) => {
            var name = a.Advertisement.LocalName ?? "";
            var hr = a.Advertisement.ServiceUuids.Contains(HrService);
            lock (seen) {
                Dictionary<string, object> d;
                if (!seen.TryGetValue(a.BluetoothAddress, out d)) {
                    d = Obj("address", AddrText(a.BluetoothAddress), "name", name, "rssi", (int)a.RawSignalStrengthInDBm, "hr", hr);
                    seen[a.BluetoothAddress] = d;
                } else {
                    // the name often arrives in the scan response, the service list in the advertisement: keep both
                    if (name.Length > 0) d["name"] = name;
                    if (hr) d["hr"] = true;
                    d["rssi"] = (int)a.RawSignalStrengthInDBm;
                }
            }
        };
        w.Start();
        await Task.Delay(Math.Max(1000, Math.Min(ms, 20000)));
        w.Stop();
        if (w.Status == BluetoothLEAdvertisementWatcherStatus.Aborted) throw new InvalidOperationException("no_adapter");
        lock (seen) {
            return seen.Values.Where(d => (bool)d["hr"] || (all && ((string)d["name"]).Length > 0)).ToList();
        }
    }

    static void Drop() {
        try { if (Measurement != null) Measurement.ValueChanged -= OnMeasurement; } catch { }
        try { if (Battery != null) Battery.ValueChanged -= OnBattery; } catch { }
        try { if (Device != null) { Device.ConnectionStatusChanged -= OnLink; Device.Dispose(); } } catch { }
        Device = null; Measurement = null; Battery = null;
    }

    static void OnMeasurement(GattCharacteristic c, GattValueChangedEventArgs e) {
        Send(Obj("type", "hr", "address", AddrText(Address), "hex", Hex(e.CharacteristicValue.ToArray())));
    }
    static void OnBattery(GattCharacteristic c, GattValueChangedEventArgs e) {
        var b = e.CharacteristicValue.ToArray();
        if (b.Length > 0) Send(Obj("type", "battery", "address", AddrText(Address), "percent", (int)b[0]));
    }
    static void OnLink(BluetoothLEDevice d, object o) {
        Send(Obj("type", "link", "address", AddrText(Address), "connected", d.ConnectionStatus == BluetoothConnectionStatus.Connected));
    }

    static async Task<GattDeviceServicesResult> HrServices(BluetoothLEDevice dev) {
        var sr = await dev.GetGattServicesForUuidAsync(HrService, BluetoothCacheMode.Uncached);
        if (sr.Status == GattCommunicationStatus.AccessDenied || sr.Status == GattCommunicationStatus.ProtocolError) {
            // Some devices want a bond before they show their services. Pair with "confirm only" (no PIN), then ask again.
            var p = dev.DeviceInformation.Pairing;
            if (!p.IsPaired && p.CanPair) {
                Log("pairing with the device");
                p.Custom.PairingRequested += (s, a) => a.Accept();
                var pr = await p.Custom.PairAsync(DevicePairingKinds.ConfirmOnly | DevicePairingKinds.ConfirmPinMatch);
                Log("pairing: " + pr.Status);
                sr = await dev.GetGattServicesForUuidAsync(HrService, BluetoothCacheMode.Uncached);
            }
        }
        return sr;
    }

    static async Task<Dictionary<string, object>> Connect(ulong address) {
        await Gate.WaitAsync();
        try {
            Drop();
            Address = address;
            var dev = await BluetoothLEDevice.FromBluetoothAddressAsync(address);
            if (dev == null) throw new InvalidOperationException("not_found");
            var sr = await HrServices(dev);
            if (sr.Status == GattCommunicationStatus.AccessDenied) { dev.Dispose(); throw new InvalidOperationException("access_denied"); }
            if (sr.Status != GattCommunicationStatus.Success || sr.Services.Count == 0) { dev.Dispose(); throw new InvalidOperationException("no_service"); }
            var cr = await sr.Services[0].GetCharacteristicsForUuidAsync(HrMeasurement, BluetoothCacheMode.Uncached);
            if (cr.Status != GattCommunicationStatus.Success || cr.Characteristics.Count == 0) { dev.Dispose(); throw new InvalidOperationException("no_service"); }
            Device = dev;
            Measurement = cr.Characteristics[0];
            Measurement.ValueChanged += OnMeasurement;
            var st = await Measurement.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify);
            if (st != GattCommunicationStatus.Success) { Drop(); throw new InvalidOperationException(st == GattCommunicationStatus.AccessDenied ? "access_denied" : "no_service"); }
            dev.ConnectionStatusChanged += OnLink;
            object battery = null;
            try {
                var bs = await dev.GetGattServicesForUuidAsync(BatteryService, BluetoothCacheMode.Uncached);
                if (bs.Status == GattCommunicationStatus.Success && bs.Services.Count > 0) {
                    var bc = await bs.Services[0].GetCharacteristicsForUuidAsync(BatteryLevel, BluetoothCacheMode.Uncached);
                    if (bc.Status == GattCommunicationStatus.Success && bc.Characteristics.Count > 0) {
                        Battery = bc.Characteristics[0];
                        var rv = await Battery.ReadValueAsync(BluetoothCacheMode.Uncached);
                        if (rv.Status == GattCommunicationStatus.Success) { var b = rv.Value.ToArray(); if (b.Length > 0) battery = (int)b[0]; }
                        if ((Battery.CharacteristicProperties & GattCharacteristicProperties.Notify) != 0) {
                            Battery.ValueChanged += OnBattery;
                            await Battery.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify);
                        }
                    }
                }
            } catch (Exception ex) { Log("battery: " + ex.Message); }
            Send(Obj("type", "link", "address", AddrText(address), "connected", true));
            return Obj("name", dev.Name ?? "", "battery", battery);
        } finally { Gate.Release(); }
    }

    static async Task Handle(Dictionary<string, object> m) {
        object idv; m.TryGetValue("id", out idv);
        var op = m.ContainsKey("op") ? m["op"] as string : null;
        try {
            if (op == "scan") {
                var ms = m.ContainsKey("ms") ? Convert.ToInt32(m["ms"]) : 6000;
                var all = m.ContainsKey("all") && m["all"] is bool && (bool)m["all"];
                Send(Obj("id", idv, "ok", true, "devices", await Scan(ms, all)));
            } else if (op == "connect") {
                var r = await Connect(ParseAddr(m["address"]));
                Send(Obj("id", idv, "ok", true, "name", r["name"], "battery", r["battery"]));
            } else if (op == "disconnect") {
                await Gate.WaitAsync();
                try { Drop(); } finally { Gate.Release(); }
                Send(Obj("id", idv, "ok", true));
            } else {
                Send(Obj("id", idv, "ok", false, "error", "bad_params", "message", "unknown op"));
            }
        } catch (Exception e) {
            var known = new[] { "bad_params", "not_found", "no_service", "access_denied", "no_adapter" };
            var code = e is TimeoutException ? "timeout" : known.Contains(e.Message) ? e.Message : "failed";
            Send(Obj("id", idv, "ok", false, "error", code, "message", e.Message.Length > 200 ? e.Message.Substring(0, 200) : e.Message));
        }
    }

    public static void Main() {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        Send(Obj("type", "ready"));
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            line = line.Trim();
            if (line.Length == 0 || line.Length > 4000) continue;
            Dictionary<string, object> m;
            try { m = Json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
            if (m == null) continue;
            var copy = m;
            Task.Run(() => Handle(copy));
        }
        Drop();
    }
}
