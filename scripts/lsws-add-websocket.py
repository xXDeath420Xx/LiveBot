#!/usr/bin/env python3
"""Add a LiteSpeed `websocket <uri> { address <host:port> }` block to the certifriedmultitool.com vhost.

Run as root:  sudo python3 scripts/lsws-add-websocket.py /stream/bot/ws 127.0.0.1:3001
Then:         sudo /usr/local/lsws/bin/lswsctrl restart

Backs the vhost up first (vhost.conf.bak-ws-<time>), keeps its owner and mode, refuses to write if braces do not
balance, and does nothing if a websocket block for that URI already exists.
"""
import os, re, shutil, sys, time

VHOST = '/usr/local/lsws/conf/vhosts/certifriedmultitool.com/vhost.conf'
if len(sys.argv) != 3:
    sys.exit('usage: lsws-add-websocket.py <uri> <host:port>')
uri, addr = sys.argv[1], sys.argv[2]
if not re.fullmatch(r'/[A-Za-z0-9/_.-]+', uri):
    sys.exit('bad uri')
if not re.fullmatch(r'127\.0\.0\.1:\d{2,5}', addr):
    sys.exit('address must be 127.0.0.1:<port>')
if os.geteuid() != 0:
    sys.exit('run with sudo')

src = open(VHOST, encoding='utf-8').read()
if re.search(r'^\s*websocket\s+' + re.escape(uri) + r'\s*\{', src, re.M):
    print(f'websocket {uri} already present: nothing to change')
    sys.exit(0)
block = f'websocket {uri} {{\n  address                 {addr}\n}}\n'
text = src if src.endswith('\n') else src + '\n'
text += block
if text.count('{') != text.count('}'):
    sys.exit('refusing to write: braces do not balance')
st = os.stat(VHOST)
backup = f'{VHOST}.bak-ws-{time.strftime("%Y%m%d-%H%M%S")}'
shutil.copy2(VHOST, backup)
tmp = VHOST + '.ws-tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(text)
os.chown(tmp, st.st_uid, st.st_gid)
os.chmod(tmp, st.st_mode & 0o7777)
os.replace(tmp, VHOST)
print(f'added websocket {uri} -> {addr}; backup at {backup}')
print('now run: sudo /usr/local/lsws/bin/lswsctrl restart')
