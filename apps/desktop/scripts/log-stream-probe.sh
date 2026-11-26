#!/usr/bin/env bash
# Can a standard (non-admin) macOS user read its own processes' log with `log stream`? (gpu_watch.rs depends on it.)
# CI only (Diagnose): creates a throwaway standard user, runs the probe as it, then as the admin runner, and deletes it.
set -u
sudo sysadminctl -addUser scstd -password "$(openssl rand -hex 12)" >/dev/null 2>&1
echo "admin member: $(dseditgroup -o checkmember -m scstd admin 2>&1)"
cat > /tmp/probe.sh <<'P'
cd /tmp
log stream --style ndjson --predicate "processID == $$ OR eventMessage CONTAINS \"scenecast gpu-watch marker\"" > "/tmp/probe-$(id -un).out" 2> "/tmp/probe-$(id -un).err" & s=$!
sleep 3; logger -p user.notice "scenecast gpu-watch marker"; sleep 3; kill $s 2>/dev/null; wait $s 2>/dev/null
echo "user $(id -un): stderr: $(head -1 "/tmp/probe-$(id -un).err"); marker lines: $(grep -c '"eventMessage":"scenecast gpu-watch marker"' "/tmp/probe-$(id -un).out")"
P
chmod 755 /tmp/probe.sh
sudo -u scstd -H /bin/bash /tmp/probe.sh
/bin/bash /tmp/probe.sh
sudo sysadminctl -deleteUser scstd >/dev/null 2>&1
