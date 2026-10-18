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

sudo -u "$NODE_USER" -H bash -lc "cd $NODE_HOME/snapchain && curl -sSL https://raw.githubusercontent.com/farcasterxyz/snapchain/refs/heads/main/scripts/snapchain-bootstrap.sh | bash"

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
