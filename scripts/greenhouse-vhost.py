#!/usr/bin/env python3
"""Greenhouse Tycoon cutover, step 4 (docs/greenhouse-cutover.md): LiteSpeed vhost edit for certifriedmultitool.com.

Run as root:  sudo python3 /tmp/kbddeploy/greenhouse-vhost.py [--dry-run] [path]
Then:         sudo /usr/local/lsws/bin/lswsctrl restart

  a. adds   extprocessor greenhouse_v2 (127.0.0.1:4021), context /gh-api/ and websocket /gh-api/ws
  b. removes the old game's context /cfx-api/ and /cfx, websocket /cfx-api/ws and /cfx/ws, and extprocessor
     cfxbackend (127.0.0.1:4020) once nothing uses it. /cfx and /cfx-api then reach the dashboard, which forwards
     the frozen game's API until GREENHOUSE_LIVE=1 and answers 301/410 after.

Backs the file up first (vhost.conf.bak-greenhouse-<time>), keeps its owner and mode, and refuses to write if the
braces do not balance. Running it twice changes nothing the second time.
"""
import os, re, shutil, sys, time

PATH = next((a for a in sys.argv[1:] if not a.startswith('--')),
            '/usr/local/lsws/conf/vhosts/certifriedmultitool.com/vhost.conf')
DRY = '--dry-run' in sys.argv

OLD_CONTEXTS = {'/cfx', '/cfx/', '/cfx-api', '/cfx-api/'}
OLD_SOCKETS = {'/cfx-api/ws', '/cfx/ws'}
HEAD = re.compile(r'^\s*(extprocessor|context|websocket)\s+(\S+)\s*\{\s*$')

NEW_PROCESSOR = """  extprocessor greenhouse_v2 {
    type                    proxy
    address                 127.0.0.1:4021
    maxConns                100
    pcKeepAliveTimeout      60
    initTimeout             20
    retryTimeout            0
    respBuffer              0
  }
  context /gh-api/ {
    type                    proxy
    handler                 greenhouse_v2
    addDefaultCharset       off
  }
"""
NEW_SOCKET = """websocket /gh-api/ws {
  address                 127.0.0.1:4021
}
"""


def blocks(lines):
    """Top-level extprocessor/context/websocket blocks: (kind, name, start, end_exclusive, body)."""
    out, i = [], 0
    while i < len(lines):
        m = HEAD.match(lines[i])
        if not m:
            i += 1
            continue
        depth, j = 0, i
        while j < len(lines):
            depth += lines[j].count('{') - lines[j].count('}')
            j += 1
            if depth == 0:
                break
        if depth != 0:
            sys.exit(f'unbalanced block starting at line {i + 1}: {lines[i].strip()}')
        out.append((m.group(1), m.group(2), i, j, ''.join(lines[i:j])))
        i = j
    return out


def main():
    if not DRY and PATH.startswith('/usr/local/lsws/') and os.geteuid() != 0:
        sys.exit('run with sudo (or add --dry-run)')
    src = open(PATH, encoding='utf-8').read()
    lines = src.splitlines(keepends=True)
    if lines and not lines[-1].endswith('\n'):
        lines[-1] += '\n'
    found = blocks(lines)
    names = [(k, n) for k, n, *_ in found]
    if ('context', '/') not in names:
        sys.exit('no "context /" block found; is this the right file?')

    drop, log = set(), []
    for k, n, s, e, body in found:
        if (k == 'context' and n in OLD_CONTEXTS) or (k == 'websocket' and n in OLD_SOCKETS):
            drop.add(s)
            log.append(f'remove {k} {n}')
    kept_handlers = {re.search(r'handler\s+(\S+)', b).group(1) for k, n, s, e, b in found
                     if k == 'context' and s not in drop and re.search(r'handler\s+(\S+)', b)}
    for k, n, s, e, body in found:
        if k == 'extprocessor' and n == 'cfxbackend':
            if n in kept_handlers:
                log.append('keep extprocessor cfxbackend (another context still uses it)')
            elif '127.0.0.1:4020' in body:
                drop.add(s)
                log.append('remove extprocessor cfxbackend')

    have_new = any(n == 'greenhouse_v2' for k, n in names)
    have_sock = ('websocket', '/gh-api/ws') in names
    last_root = max(s for k, n, s, e, b in found if (k, n) == ('context', '/'))

    out = []
    ends = {s: e for k, n, s, e, b in found}
    i = 0
    while i < len(lines):
        if i == last_root and not have_new:
            out.append(NEW_PROCESSOR)
            log.append('add extprocessor greenhouse_v2 and context /gh-api/ (before the last "context /")')
        if i in drop:
            i = ends[i]
            continue
        out.append(lines[i])
        i += 1
    if not have_sock:
        out.append(NEW_SOCKET)
        log.append('add websocket /gh-api/ws')
    if have_new:
        log.append('greenhouse_v2 already present: not added again')

    text = ''.join(out)
    if text.count('{') != text.count('}'):
        sys.exit('refusing to write: braces do not balance after the edit')
    after = [(k, n) for k, n, *_ in blocks(text.splitlines(keepends=True))]
    missing = [x for x in [('extprocessor', 'greenhouse_v2'), ('context', '/gh-api/'), ('websocket', '/gh-api/ws'),
                           ('context', '/')] if x not in after]
    leftover = [x for x in after if (x[0] == 'context' and x[1] in OLD_CONTEXTS) or
                (x[0] == 'websocket' and x[1] in OLD_SOCKETS)]
    if missing or leftover:
        sys.exit(f'refusing to write: missing {missing}, leftover {leftover}')

    for line in log:
        print(line)
    if text == src or text == ''.join(lines):
        print('nothing to change')
        return
    if DRY:
        print('dry run: file not written')
        return
    st = os.stat(PATH)
    backup = f'{PATH}.bak-greenhouse-{time.strftime("%Y%m%d-%H%M%S")}'
    shutil.copy2(PATH, backup)
    tmp = PATH + '.greenhouse-tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.chown(tmp, st.st_uid, st.st_gid)
    os.chmod(tmp, st.st_mode & 0o7777)
    os.replace(tmp, PATH)
    print(f'written; backup at {backup}')
    print('now run: sudo /usr/local/lsws/bin/lswsctrl restart')


main()
