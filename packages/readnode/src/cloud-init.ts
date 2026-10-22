export interface CloudInitOptions {
  fid: number;
  dataDir?: string;
  skipCrontab?: boolean;
  blockedIps?: string[];
}

export function renderCloudInit(options: CloudInitOptions): string {
  const dataDir = options.dataDir ?? "/home/ubuntu";
  const skipCrontab = options.skipCrontab ?? false;

  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl jq

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi

if id ubuntu >/dev/null 2>&1; then
  usermod -aG docker ubuntu
fi

NODE_USER="ubuntu"
if ! id "$NODE_USER" >/dev/null 2>&1; then
  NODE_USER="root"
fi

NODE_HOME="${dataDir}"
if [ "$NODE_USER" = "root" ]; then
  NODE_HOME="/root"
fi

install -d -o "$NODE_USER" -g "$NODE_USER" "$NODE_HOME/snapchain"
cat > "$NODE_HOME/snapchain/.env" <<'READNODE_ENV'
AGREE_NO_REWARDS_FOR_ME=true
HUB_OPERATOR_FID=${options.fid}
READNODE_ENV
${skipCrontab ? `echo "SKIP_CRONTAB=true" >> "$NODE_HOME/snapchain/.env"` : ""}
chown -R "$NODE_USER:$NODE_USER" "$NODE_HOME/snapchain"

# The official bootstrap ends in \`exec ./snapchain.sh upgrade < /dev/tty\`, which
# fails with no terminal (cloud-init, \`ssh host bash -s\`). And \`upgrade\` itself
# ends in \`docker compose logs -f\`, which never returns. So fetch snapchain.sh
# directly, run it with no stdin, and stop following logs once it says it's done.
cd "$NODE_HOME/snapchain"
curl -fsSL "https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/scripts/snapchain.sh?t=$(date +%s)" -o snapchain.sh
chmod +x snapchain.sh
chown "$NODE_USER:$NODE_USER" snapchain.sh

./snapchain.sh upgrade </dev/null >upgrade.log 2>&1 &
UPGRADE_PID=$!
for _ in $(seq 1 360); do
  grep -q "Upgrade complete" upgrade.log && break
  kill -0 "$UPGRADE_PID" 2>/dev/null || break
  sleep 5
done
kill "$UPGRADE_PID" 2>/dev/null || true
pkill -f "logs --tail 100 -f snapchain" 2>/dev/null || true

if ! grep -q "Upgrade complete" upgrade.log; then
  echo "snapchain.sh upgrade did not finish. Last lines of upgrade.log:"
  tail -n 40 upgrade.log
  exit 1
fi

systemctl enable docker >/dev/null 2>&1 || true

echo "READNODE_PROVISION_COMPLETE"
`;
}

export function renderFirewallScript(ports = [3381, 3382, 3383]): string {
  const rules = ports
    .map(
      (port) => `iptables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`,
    )
    .join("\n");
  return `#!/bin/bash
set -euo pipefail
apt-get update
apt-get install -y --no-install-recommends iptables
${rules}
iptables -C INPUT -p udp --dport 3382 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 3382 -j ACCEPT
command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save || true
`;
}
