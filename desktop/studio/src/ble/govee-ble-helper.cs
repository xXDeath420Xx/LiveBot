/*
 * CertiFried Studio: Govee Bluetooth LE helper (Studio 0.2.11).
 *
 * Why a helper and not a Node library: @abandonware/noble on Windows talks to the Bluetooth adapter through WinUSB, which
 * needs the adapter's driver replaced (Zadig) and takes the adapter away from Windows. Windows' own WinRT Bluetooth API
 * (Windows.Devices.Bluetooth, Windows 10 1703 and later) works with the normal driver and alongside other apps, but it
 * needs .NET/WinRT; Windows PowerShell 5.1 cannot subscribe to WinRT events (advertisements, GATT notifications). So this
 * is a small C# program, built with the C# compiler that comes with the .NET Framework on every Windows 10/11
 * (scripts/build-ble-helper.ps1), shipped next to speech-helper.ps1 and started by src/main/lights/govee-ble.js.
 *
 * Protocol: one JSON object per line on stdin, one per line on stdout.
 *   { id, op: 'scan', ms }                       → { id, ok, devices: [{ address, name, rssi }] }  (Govee names only)
 *   { id, op: 'connect', address }               → { id, ok }   (keeps the connection, keep-alive, reconnects)
 *   { id, op: 'write', address, hex }            → { id, ok }   (20-byte packet, hex)
 *   { id, op: 'query', address, hex, ms }        → { id, ok, hex }  (writes, waits for the notification that starts with
 *                                                                     the same two bytes)
 *   { id, op: 'disconnect', address }            → { id, ok }
 *   events: { type: 'ready' } | { type: 'link', address, connected } | { type: 'log', message }
 * Errors: { id, ok: false, error: code, message }. Codes: not_found, no_service, write_failed, timeout, bad_params, no_adapter.
 *
 * GATT: service 00010203-0405-0607-0809-0a0b0c0d1910, write 00010203-0405-0607-0809-0a0b0c0d2b11, notify ...2b10
 * (homebridge-govee lib/utils/ble-protocol.js UUID; Beshelmek/govee_ble_lights UUID_CONTROL_CHARACTERISTIC).
 * Keep-alive: while connected, 0xAA 0x01 (a power status request; 0xAA is the status packet id in homebridge-govee) every
 * 2 s, as community captures describe (Home Assistant forum "Govee Bluetooth lights": "at least every 2 seconds").
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
using Windows.Storage.Streams;

public static class GoveeBleHelper {
    static readonly Guid Service = new Guid("00010203-0405-0607-0809-0a0b0c0d1910");
    static readonly Guid WriteChar = new Guid("00010203-0405-0607-0809-0a0b0c0d2b11");
    static readonly Guid NotifyChar = new Guid("00010203-0405-0607-0809-0a0b0c0d2b10");
    static readonly object OutLock = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    class Link {
        public ulong Address;
        public BluetoothLEDevice Device;
        public GattCharacteristic Write;
        public GattCharacteristic Notify;
        public readonly SemaphoreSlim Gate = new SemaphoreSlim(1, 1);
        public readonly List<KeyValuePair<string, TaskCompletionSource<byte[]>>> Waiters = new List<KeyValuePair<string, TaskCompletionSource<byte[]>>>();
        public bool Wanted = true;
        public DateTime LastWrite = DateTime.MinValue;
    }
    static readonly Dictionary<ulong, Link> Links = new Dictionary<ulong, Link>();

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
    static byte[] ParseHex(object v) {
        var s = (v as string ?? "").Trim();
        if (s.Length != 40) throw new ArgumentException("bad_params");
        var b = new byte[20];
        for (int i = 0; i < 20; i++) b[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
        return b;
    }
    static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }
    static bool IsGoveeName(string n) {
        if (string.IsNullOrEmpty(n)) return false;
        return n.StartsWith("Govee_") || n.StartsWith("ihoment_") || n.StartsWith("GBK_") || n.StartsWith("Minger_");
    }

    static async Task<List<Dictionary<string, object>>> Scan(int ms) {
        var seen = new Dictionary<ulong, Dictionary<string, object>>();
        var w = new BluetoothLEAdvertisementWatcher();
        w.ScanningMode = BluetoothLEScanningMode.Active;
        w.Received += (s, a) => {
            var n = a.Advertisement.LocalName;
            if (!IsGoveeName(n)) return;
            lock (seen) seen[a.BluetoothAddress] = Obj("address", AddrText(a.BluetoothAddress), "name", n, "rssi", (int)a.RawSignalStrengthInDBm);
        };
        w.Start();
        await Task.Delay(Math.Max(500, Math.Min(ms, 20000)));
        w.Stop();
        if (w.Status == BluetoothLEAdvertisementWatcherStatus.Aborted) throw new InvalidOperationException("no_adapter");
        lock (seen) return seen.Values.ToList();
    }

    static async Task<Link> Open(ulong address) {
        Link link;
        lock (Links) { Links.TryGetValue(address, out link); }
        if (link != null && link.Write != null && link.Device != null && link.Device.ConnectionStatus == BluetoothConnectionStatus.Connected) return link;
        if (link == null) { link = new Link { Address = address }; lock (Links) Links[address] = link; }
        link.Wanted = true;
        var dev = await BluetoothLEDevice.FromBluetoothAddressAsync(address);
        if (dev == null) throw new InvalidOperationException("not_found");
        var sr = await dev.GetGattServicesForUuidAsync(Service, BluetoothCacheMode.Uncached);
        if (sr.Status != GattCommunicationStatus.Success || sr.Services.Count == 0) { dev.Dispose(); throw new InvalidOperationException("no_service"); }
        var svc = sr.Services[0];
        var wr = await svc.GetCharacteristicsForUuidAsync(WriteChar, BluetoothCacheMode.Uncached);
        if (wr.Status != GattCommunicationStatus.Success || wr.Characteristics.Count == 0) { dev.Dispose(); throw new InvalidOperationException("no_service"); }
        link.Device = dev;
        link.Write = wr.Characteristics[0];
        var nr = await svc.GetCharacteristicsForUuidAsync(NotifyChar, BluetoothCacheMode.Uncached);
        if (nr.Status == GattCommunicationStatus.Success && nr.Characteristics.Count > 0) {
            link.Notify = nr.Characteristics[0];
            var l2 = link;
            link.Notify.ValueChanged += (c, e) => OnNotify(l2, e.CharacteristicValue.ToArray());
            try { await link.Notify.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify); } catch (Exception ex) { Log("notify: " + ex.Message); }
        }
        var l3 = link;
        dev.ConnectionStatusChanged += (d, o) => Send(Obj("type", "link", "address", AddrText(l3.Address), "connected", d.ConnectionStatus == BluetoothConnectionStatus.Connected));
        Send(Obj("type", "link", "address", AddrText(address), "connected", true));
        return link;
    }

    static void OnNotify(Link link, byte[] data) {
        if (data == null || data.Length < 2) return;
        var key = data[0].ToString("x2") + data[1].ToString("x2");
        lock (link.Waiters) {
            for (int i = 0; i < link.Waiters.Count; i++) {
                if (link.Waiters[i].Key == key) { var t = link.Waiters[i].Value; link.Waiters.RemoveAt(i); t.TrySetResult(data); return; }
            }
        }
    }

    static async Task WriteRaw(Link link, byte[] packet) {
        await link.Gate.WaitAsync();
        try {
            var opt = (link.Write.CharacteristicProperties & GattCharacteristicProperties.WriteWithoutResponse) != 0 ? GattWriteOption.WriteWithoutResponse : GattWriteOption.WriteWithResponse;
            var st = await link.Write.WriteValueAsync(packet.AsBuffer(), opt);
            if (st != GattCommunicationStatus.Success) throw new InvalidOperationException("write_failed");
            link.LastWrite = DateTime.UtcNow;
        } finally { link.Gate.Release(); }
    }

    static async Task<byte[]> Query(Link link, byte[] packet, int ms) {
        if (link.Notify == null) throw new InvalidOperationException("no_service");
        var tcs = new TaskCompletionSource<byte[]>();
        var key = packet[0].ToString("x2") + packet[1].ToString("x2");
        lock (link.Waiters) link.Waiters.Add(new KeyValuePair<string, TaskCompletionSource<byte[]>>(key, tcs));
        await WriteRaw(link, packet);
        var done = await Task.WhenAny(tcs.Task, Task.Delay(Math.Max(200, Math.Min(ms, 5000))));
        if (done != tcs.Task) { lock (link.Waiters) link.Waiters.RemoveAll(x => x.Value == tcs); throw new TimeoutException("timeout"); }
        return tcs.Task.Result;
    }

    static byte[] KeepAlive() {
        var b = new byte[20]; b[0] = 0xAA; b[1] = 0x01;
        byte x = 0; for (int i = 0; i < 19; i++) x ^= b[i]; b[19] = x;
        return b;
    }

    static async Task KeepAliveLoop() {
        while (true) {
            await Task.Delay(2000);
            List<Link> list;
            lock (Links) list = Links.Values.Where(l => l.Wanted).ToList();
            foreach (var l in list) {
                try {
                    if ((DateTime.UtcNow - l.LastWrite).TotalMilliseconds < 1800) continue;
                    if (l.Device == null || l.Write == null || l.Device.ConnectionStatus != BluetoothConnectionStatus.Connected) { await Open(l.Address); }
                    await WriteRaw(l, KeepAlive());
                } catch (Exception) { /* reconnect is tried again at the next round */ }
            }
        }
    }

    static async Task Handle(Dictionary<string, object> m) {
        object idv; m.TryGetValue("id", out idv);
        var op = m.ContainsKey("op") ? m["op"] as string : null;
        try {
            if (op == "scan") {
                var ms = m.ContainsKey("ms") ? Convert.ToInt32(m["ms"]) : 5000;
                Send(Obj("id", idv, "ok", true, "devices", await Scan(ms)));
            } else if (op == "connect") {
                await Open(ParseAddr(m["address"]));
                Send(Obj("id", idv, "ok", true));
            } else if (op == "write") {
                var link = await Open(ParseAddr(m["address"]));
                await WriteRaw(link, ParseHex(m["hex"]));
                Send(Obj("id", idv, "ok", true));
            } else if (op == "query") {
                var link = await Open(ParseAddr(m["address"]));
                var ms = m.ContainsKey("ms") ? Convert.ToInt32(m["ms"]) : 1500;
                Send(Obj("id", idv, "ok", true, "hex", Hex(await Query(link, ParseHex(m["hex"]), ms))));
            } else if (op == "disconnect") {
                var a = ParseAddr(m["address"]);
                Link link;
                lock (Links) { Links.TryGetValue(a, out link); Links.Remove(a); }
                if (link != null) { link.Wanted = false; if (link.Device != null) link.Device.Dispose(); }
                Send(Obj("id", idv, "ok", true));
            } else {
                Send(Obj("id", idv, "ok", false, "error", "bad_params", "message", "unknown op"));
            }
        } catch (Exception e) {
            var code = e is TimeoutException ? "timeout" : (e.Message == "bad_params" || e.Message == "not_found" || e.Message == "no_service" || e.Message == "write_failed" || e.Message == "no_adapter") ? e.Message : "failed";
            Send(Obj("id", idv, "ok", false, "error", code, "message", e.Message.Length > 200 ? e.Message.Substring(0, 200) : e.Message));
        }
    }

    public static void Main() {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        Send(Obj("type", "ready"));
        Task.Run(() => KeepAliveLoop());
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
        lock (Links) foreach (var l in Links.Values) { try { if (l.Device != null) l.Device.Dispose(); } catch { } }
    }
}
