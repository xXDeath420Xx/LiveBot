#!/usr/bin/env bash
# pre-push hook for the publish clone (installed by scripts/publish-github.sh).
# Refuses a push that would add env files, cookie jars, resolver secrets, key material or DB dumps,
# or any commit that is not built on the rewritten (purged) history.
z40=0000000000000000000000000000000000000000
anchor=dddaf2f8addcfc44bb34380b76037340d769fb50
bad=0
while read -r local_ref local_sha remote_ref remote_sha; do
    [ "$local_sha" = "$z40" ] && continue
    if ! git merge-base --is-ancestor "$anchor" "$local_sha" 2>/dev/null; then
        echo "pre-push BLOCKED: $local_ref is not built on the rewritten history ($anchor)" >&2
        bad=1; continue
    fi
    if [ "$remote_sha" = "$z40" ]; then range=$(git rev-list "$local_sha" --not --remotes)
    else range=$(git rev-list "$remote_sha..$local_sha"); fi
    for c in $range; do
        hits=$(git diff-tree --no-commit-id --name-only --diff-filter=AMR -r --root "$c" \
            | grep -E '(^|/)(\.env($|\.)|[^/]*\.env$|cookies\.txt|\.music-resolver-secret)|\.(pem|key|p12|pfx|db|sqlite3?|rdb|dump|sql\.gz)$' \
            | grep -vE '(^|/)\.env\.example$|\.env\.example$')
        if [ -n "$hits" ]; then
            echo "pre-push BLOCKED: commit $(git log -1 --format=%h "$c") adds secret-shaped file(s):" >&2
            echo "$hits" | sed 's/^/  /' >&2
            bad=1
        fi
    done
done
exit $bad
