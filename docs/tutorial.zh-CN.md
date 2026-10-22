# 从你自己的 Farcaster 节点读取数据

运行你自己的 Snapchain 读取节点，以及一个从它读取数据的客户端。你的信息流和你发的帖都经过你自己的节点。本工具调用的外部服务只有 fnames 注册表和一个公开的 Optimism RPC，二者都只用来查你的 FID。

> 本文是英文版教程的中文翻译。命令、代码、字段名保持原样，未做本地化改写。

---

## 快速开始

三条命令。前提：你已经有一个**租了存储**的 Farcaster 账号——请用测试账号（[如何获取](#开始之前准备一个测试账号)）。

先安装 CLI（Node 20.11+）。使用 AWS 时还需要装好 [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) 并配置好凭证（`aws configure`）。

```bash
git clone https://github.com/vaibhavmule/readnode.git && cd readnode
npm install && npm run build -w readnode
npm install -g ./packages/readnode    # 把 `readnode` 加到 PATH
```

然后：

```bash
# 0. 准备计算资源（默认 us-east-1：节点的对等方都在那里）
readnode provision --provider aws --username yourname

# 1. 安装读取节点并等待同步
readnode up

# 2. 打开客户端
readnode client
```

`--username` 接受 Farcaster 用户名。如果是 `alice.eth` 这样的 ENS 名字，请改用 `--fid <数字>`。

`readnode provision` 创建机器并装好 Docker。`readnode up` 安装 Snapchain、启动节点，并一直阻塞到节点追平链头。`readnode client` 在 `http://127.0.0.1:3939` 上提供服务——在那里导入助记词、签发应用密钥，然后就可以看信息流、发帖、关注和点赞了。

几件事要提前知道：

- 第一次运行 `up` 会**等两到三个小时**：机器在下载并解包网络状态的快照，解包后约 560 GB。Snapchain 启动后，`up` 还会继续等节点从快照追到链头。快照最多可能是一天前的，所以这一步从几分钟到大约半天不等；追赶期间客户端已经可以从节点读取。任何时候按 Ctrl-C 都是安全的，重新运行 `readnode up` 即可继续观察。
- 保持默认区域 `us-east-1`。几乎所有 Snapchain 对等节点都在 AWS us-east-1，读取节点一次只向对等方取一个区块，所以追赶速度取决于到它们的往返延迟。一台在孟买的节点每秒只能把差距缩小约 1.8 秒，一天前的快照要花半天多才能追上；靠近对等方会快得多。
- 不需要任何人的 API key。你需要一个云服务账号来租机器，云账单是唯一的开销。

---

## 你刚刚搭了什么

两个互相通信的部分：

```
        ┌──────────────────────────────┐
        │  你的 Snapchain 读取节点      │  读：信息流、帖子、回应
        │  :3381 HTTP   :3383 gRPC     │  写：转发给验证者节点
        └──────────────────────────────┘
                    ▲            │
        读 ─────────┘            └────── 写
                    │                      │
        ┌──────────────────────────────┐   │
        │  你的客户端  :3939            │   │
        │  持有一个有权限范围的应用密钥   │───┘
        └──────────────────────────────┘
```

下面解释为什么是这个形状。

---

## 开始之前：准备一个测试账号

客户端需要一个**已经有存储**的 Farcaster 账号的助记词。请专门为此新建一个账号，不要用你的主账号。

在 Farcaster 应用里新建的账号用通行密钥（passkey）登录，不会给你助记词。所以最简单的办法是直接在链上注册一个新 FID。仓库里有现成的脚本，花费约 **0.2 美元的 Optimism ETH**（一个 FID 加一个存储单位，再加 gas）：

```bash
node packages/readnode/scripts/register-test-account.mjs
# → 生成一个一次性钱包，助记词保存在 ~/.readnode/test-account.json（权限 0600），并打印地址

# 往该地址转约 0.0005 ETH（Optimism 网络），然后：
node packages/readnode/scripts/register-test-account.mjs register
# → 调用 IdGateway.register()，打印你的新 FID
```

`~/.readnode/test-account.json` 里的助记词就是要导入客户端的那个。这个账号没有用户名，客户端按 FID 显示它。如果你已经有一个用助记词创建的账号（较早的 Warpcast 账号，或你自己注册的），而且丢了也不心疼，也可以用它。

想手动注册的话，官方的[创建账号](https://docs.farcaster.xyz/developers/guides/accounts/create-account)指南讲解了 `IdGateway` 和 `Bundler`。

---

## 第一部分 · Farcaster 是两套系统

Farcaster 把**身份放在链上**，把**数据放在链下**。几乎所有让人困惑的地方都来自这个切分，所以从这里开始。

**链上**——OP Mainnet（chain id 10）上的少量合约。只做三件事：创建账号、支付存储、授权密钥。这些是低频事件，所以允许它们慢一点、花点 gas。

**链下**——其他所有东西：发帖、关注、回应、改资料。这就是 Snapchain，一个点对点的节点网络。快、便宜、有签名。

连接两半的桥梁是**签名**。一条消息只有在「链上合约认定该密钥属于该账号」时才算有效。

### FID

**FID** 就是 Farcaster 的账号编号，是单纯的递增整数：`1` 就是 `@farcaster`。FID 由 Optimism 上的 `IdRegistry` 合约签发。

协议里到处都是整数 FID，但人想要名字，所以有一个 `fnames` 注册表做名字到 FID 的映射。它是链下的，且公开：

```bash
curl 'https://fnames.farcaster.xyz/transfers?name=farcaster'
curl 'https://fnames.farcaster.xyz/transfers/current?fid=1'
```

第一个响应就会给出 FID。`readnode provision --username yourname` 做的就是这件事——不需要密钥，也不需要账号。

### 托管地址（custody address）

每个 FID 有一个**托管地址**：拥有它的以太坊地址。它可以转移 FID、更改恢复地址，以及——这里是关键——**授权和撤销密钥**。

`IdRegistry` 可以双向查询：

```solidity
idOf(address)   → 该地址拥有的 FID（没有则返回 0）
custodyOf(fid)  → 拥有该 FID 的地址
```

你的助记词会推导出一个以太坊地址。如果这个地址不是你要用的 FID 的托管地址，后面的每一步都会失败——你会收到看起来像「节点坏了」的签名错误。客户端在导入时会检查这一点并明确告诉你。

### 应用密钥（app key / signer）

**你不用托管密钥签名消息。**你用一个**应用密钥**——一对独立的 Ed25519 密钥——来签名，而托管密钥只授权它一次。

```
托管密钥（以太坊、链上、需要保护）
      │  授权一次
      ▼
应用密钥（Ed25519、链下、有权限范围、会过期）
      │  签名
      ▼
帖子、关注、回应  →  Snapchain
```

泄露的应用密钥可以冒充你发帖，直到它被撤销或过期。它不能转移 FID，也不能授权其他密钥。

### 存储租金

写入 Snapchain 要花存储，而存储是按 FID **在链上**按「单位」租的。不同类型的消息消耗不同——发帖和点赞不是一个价，具体比例由节点告诉你：

```bash
curl 'http://127.0.0.1:3381/v1/storageLimitsByFid?fid=1'
```

它返回每个类别的 `limit` 和 `used`。

两个值得记牢的推论：

1. **存储是按账号计的上限，由协议强制执行。** 没有存储的 FID 完全不能写入。某个类别满了之后，节点会删掉该类别里最旧的消息，为新消息腾出空间。
2. **这就是本教程要求「账号已经有存储」的原因。** 租存储意味着在 Optimism 上发一笔交易。客户端从不发交易，只读取 Optimism 来查你的 FID。（测试账号脚本只发一笔交易 `IdGateway.register`，它在注册 FID 的同时租下第一个存储单位。）

### Snapchain 消息

消息是链下一切的基本单位。它由三部分组成：

- **`data`**——负载。类型（`CAST_ADD`、`REACTION_ADD`、`LINK_ADD`、`USER_DATA_ADD`、`KEY_ADD`……）、作者 `fid`、时间戳、消息体。
- **`hash`**——对序列化后的 `data` 做 BLAKE3，截断到 20 字节。
- **`signature` 和 `signer`**——对**哈希**的 Ed25519 签名，以及产生它的公钥。

所以顺序是：序列化 `data`、算哈希、对哈希签名、把两者附上。签名从不参与哈希计算。

时间戳是**自 Farcaster 纪元**（2021-01-01 00:00:00 UTC）起的秒数，不是 Unix 时间。像 `182822400` 这样的原始值是一个正常的 2026 年时间戳；打印时要先加上 `1609459200`。

走 HTTP API 时，哈希和公钥是 `0x` 开头的十六进制，签名是 base64；走 gRPC 时全都是原始字节。把测试数据在两者之间搬运时，这一点经常坑人。

---

## 第二部分 · 读取节点

每个 Snapchain 节点运行的都是同一个二进制，一个配置项决定它的角色：

```toml
read_node = true    # 读取节点
read_node = false   # 验证者节点
```

### 读取节点 vs 验证者节点

|  | 验证者节点 | 读取节点 |
| --- | --- | --- |
| 谁能运行 | 持有验证者集合中密钥的人 | 任何人 |
| 共识 | 提议并对区块投票 | 从不投票；从对等节点同步已决区块 |
| 验证者集合 | 从链上配置注册表拉取 | 静态，来自 `validators.toml` |
| `/v1/info` 中的 `mempoolSize` | 真实的每分片计数 | `4294967295`，表示「未上报」 |
| 重启它 | 会让每个分片少一票，直到它回来 | 随时安全 |

验证者需要持有**验证者集合**中的密钥，而这是需要许可的：不是你想加入就能加入。读取节点则是任何人都能运行的角色：它订阅已决区块，对照验证者集合验证提交证书，应用它们，并对外提供 API。状态相同，稍微落后，不参与投票。

这就是本教程采用这个角色的原因，也是它随时可重启的原因：不会干扰共识。

### 读取节点接受写入，但没有 mempool

`submitMessage` 在**两种**角色上都能用。区别在于消息之后的去向：

**提交给验证者节点**——消息进入该验证者对应分片的 mempool。该验证者还会把它 gossip 到 `mempool` 主题上，因此任何验证者都可以把它打包。直接提交给某个验证者的消息，即使 gossip 丢失，仍会被该验证者提议上链。

**提交给读取节点**——读取节点**没有自己的 mempool**。它把消息路由到某个分片、对照该分片状态验证、gossip 到 `mempool` 主题，然后什么都不留。消息只有在某个验证者从 gossip 中拿到它时才会进块。如果 gossip 丢失，消息就没了，必须重新提交。

所以：读取节点**确实**接受你的写入，也**确实**会转发。只是它的保证比直接提交给验证者要弱一些。

客户端从 `--node-url` 读取，默认也向同一个节点提交。如果你能访问某个验证者的 HTTP 端点，可以把两者分开：

```bash
readnode client --submit-url https://<验证者>:3381
```

读取仍然来自你自己的节点；发帖、关注、点赞以及 `KEY_ADD` 都发往验证者。`--auth` 只作用于读取节点。

无论哪种方式，`submitMessage` 返回 `200` 只意味着**消息通过了验证并被接受用于转发**——不代表它已经进块。要确认上链，请监听 `MERGE_MESSAGE` 事件，或者把消息读回来：

```bash
curl 'http://127.0.0.1:3381/v1/castsByFid?fid=<你的fid>&pageSize=1&reverse=true'
```

这也解释了为什么读取节点的 `/v1/info` 里 `mempoolSize: 4294967295` 是正常的：那是 `u32::MAX`，意思是「未上报」。它既不是溢出，也不是节点坏了的征兆。

### 为什么硬件规格是这样

**16 GB 内存 / 4 CPU。** 节点把主网全量状态放在 RocksDB 里。

**2 TB 磁盘（默认值）。** 数据库本身比这小：

```bash
curl -s localhost:3381/v1/info | jq '.dbStats.approxSize'
# 约 557 GB
```

多出来的空间是给第一次同步用的。快照以压缩分块的形式下载，有一段时间分块和解包后的数据库同时占着磁盘。Snapchain 自带的下载器会在 `.rocks.snapshot/` 里放一整份副本，峰值约 1.1 TB，所以在 1 TB 的盘上会中途写满，节点以一个毫无帮助的错误挂掉。

`readnode` 会在 Snapchain 第一次启动之前自己下载快照，放在 `.rocks.readnode/`。每个分片一下载完就解包并删掉它的分块，所以峰值更低：实测约 **800 GB**。因此用 `readnode` 时 1 TB 也够，但留给数据库增长的空间很少；`--disk-gb 2048` 是稳妥的默认值。

自己下载快照还有第二个原因。快照桶每天为每个分片发布一个新快照，并立即删除旧的。Snapchain 的下载器只读一次快照列表，然后花几个小时依次下载各分片，所以在轮到之前就已轮换的分片会返回 404。节点崩溃、以非空数据库重启、跳过快照，然后从创世块开始同步那个分片，这要花好几天。`readnode` 在下载每个分片前重新读取列表，分片若在下载中途轮换就重新开始，并同时下载八个分块。进度写在 `/var/log/readnode-snapshot.log`，`readnode up` 会把它打印出来。

**端口。** 三个端口都必须能从公网访问：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 3381 | TCP | HTTP API |
| 3382 | UDP | gossip，基于 QUIC 的 libp2p |
| 3383 | TCP | gRPC API |

`3382/UDP` 负责节点之间的 gossip，也是最容易被漏掉的——因为它不是 TCP，你也永远不会去 `curl` 它。如果你同时处在云防火墙和主机防火墙后面，两边都要放开。

### 观察同步进度

```bash
readnode status
curl -s localhost:3381/v1/info | jq
```

`blockDelay` 是某个分片最新区块落后于墙上时钟的秒数。节点追赶期间它会逐渐下降；当每个分片都降到个位数，就同步完成了。`maxHeight` 在各分片之间不同，因为每个分片是独立的链——不要把它当成故障。

读取节点同步成功时日志里是 `Processed decided block`。`Decided value with round` 是验证者的日志行；如果你在读取节点上看到它，说明配置有问题。

---

## 第三部分 · 客户端

### 第 1 步 —— 导入助记词

客户端接收 BIP-39 助记词并推导出托管账户：地址用来查你的 FID，私钥用来在第 2 步签授权。助记词只在那次请求里使用，从不落盘。

有了托管地址，它用一个公开的 RPC 端点（无需密钥）在 Optimism 上查出你的 FID，再确认 `custodyOf(fid)` 就是同一个地址。如果不是，请立刻停下：你正准备在一个你并不控制的账号上授权密钥。

### 第 2 步 —— 签发应用密钥

过去这一步需要向 `KeyGateway.add()` 发一笔 Optimism 交易。现在不需要了。Snapchain 接受**免 gas 签名密钥**：你只要向节点提交一条 `KEY_ADD` 消息就完成注册。没有交易，没有 gas，大约一秒。

`KEY_ADD` 特殊之处在于它携带**两个 EIP-712 签名，外加消息信封自身的签名**，各司其职：

1. **`SignedKeyRequest`，来自发起请求的应用。** 把应用的 `requestFid` 和密钥绑定，从而应用无法冒充其他应用的身份。它以 ABI 编码形式放进消息体的 `metadata` 字段。
2. **`KeyAdd`，来自接收密钥的 FID 的托管地址。** 这才是真正的授权。它覆盖了**权限范围、TTL 和 nonce**，所以这三者在传输途中都无法被篡改。
3. **信封签名**，由新的 Ed25519 密钥自己产生——证明提交 `KEY_ADD` 的人确实持有对应私钥。这也是 `KEY_ADD` 能豁免「签名者必须已注册」检查的原因。

**陷阱。** 有两个函数看起来可以互换，其实不能：

- `getSignedKeyRequestMetadata()` 签的是**链上**的 `Farcaster SignedKeyRequestValidator` 域——chain id 10，带 `verifyingContract`。
- `getGaslessSignedKeyRequestMetadata()` 签的是对应的**链下**域。

如果你用前者构造 metadata 并作为 `KEY_ADD` 提交，Snapchain 会拒绝。请使用 `makeKeyAddBody()`，它会自动选择链下版本。

免 gas 密钥与旧的链上密钥有三点不同：

**权限范围（scopes）。** 每个免 gas 密钥都要声明它能签哪些消息类型。只授予 `CAST_ADD` 的密钥不能发 `LINK_ADD`。本客户端只申请它真正需要的集合：

```
cast:add、cast:remove、reaction:add、reaction:remove、
link:add、link:remove、user-data:add、
verification:add、verification:remove
```

`KEY_ADD` 和 `KEY_REMOVE` **永远**不能作为权限范围。签名者不能铸造或撤销另一个签名者——如果允许，一个泄露的应用密钥就能给自己签发无限个后继密钥。链上签名者早于范围机制，没有权限范围。

**滑动 TTL。** 每个密钥的 TTL 最长 90 天；本客户端申请 30 天。每次该密钥签署的消息被合并时，TTL 就会重置，所以在用的密钥会一直存活，被弃用的密钥会自行过期。

**Nonce。** 每个 FID 有一个单调递增的用户 nonce。每条 `KEY_ADD` 携带的 nonce 必须严格大于该 FID 的当前值，这让被截获的授权无法重放。先读当前值：

```bash
curl 'http://127.0.0.1:3381/v1/signersByFid?fid=<你的fid>' | jq '.currentUserNonce'
```

然后提交 `currentUserNonce + 1`。如果你要写重试逻辑：**重试必须重新读取 nonce。** 重放同一条已签名的 `KEY_ADD` 会失败并返回 `nonce is not greater than stored nonce`，沿用旧值的重试同样会失败。

请使用 `GET /v1/signersByFid`。旧的 `GetOnChainSignersByFid` 只返回链上密钥，已废弃——对于只有免 gas 密钥的账号，它会返回空列表。

单个 FID 最多可持有 1000 个活跃的免 gas 密钥，与链上密钥分开计数。免 gas 签名密钥自引擎版本 **V16** 起在主网可用。

### 第 3 步 —— 读、发帖、关注、点赞

读走你自己的节点：

```bash
curl 'http://127.0.0.1:3381/v1/castsByFid?fid=<你的fid>&pageSize=10&reverse=true'
curl 'http://127.0.0.1:3381/v1/userDataByFid?fid=<你的fid>'
curl 'http://127.0.0.1:3381/v1/linksByFid?fid=<你的fid>&link_type=follow'
curl 'http://127.0.0.1:3381/v1/reactionsByCast?target_fid=<对方fid>&target_hash=0x…&reaction_type=Like'
```

常用参数：`pageSize`、`pageToken`、`reverse=true`，以及部分端点支持 `startTimestamp` / `stopTimestamp`。分页基于 token——沿着 `nextPageToken` 一直取到空为止。

写操作是：构造消息、用应用密钥签名、序列化，然后以原始 protobuf 字节 POST 出去：

```bash
curl -X POST http://127.0.0.1:3381/v1/submitMessage \
  -H 'content-type: application/octet-stream' \
  --data-binary @message.encoded.protobuf
```

`Message.encode(msg).finish()` 产生这些字节。注意 content type：该端点**不接受** JSON。

### 第 4 步 —— 按客户端过滤信息流

Farcaster 不把客户端名字写进消息，那怎么知道一条帖子是哪个应用发的？

靠签它的应用密钥。每条帖子都由某个应用密钥签名，而每个**免 gas** 应用密钥都带有 `requestFid`——就是申请该密钥的应用的 FID，来源是注册密钥时被验证过的 `SignedKeyRequest` 元数据。

所以链路是：`cast.signer` → 作者的密钥列表 → `requestFid` → 哪个客户端。

```bash
curl 'http://127.0.0.1:3381/v1/signersByFid?fid=<作者fid>' | jq '.signers[] | {key, requestFid, scopes, expiresAt}'
```

客户端会为你信息流里的每个作者解析这些信息，并给每条帖打上标签。于是「只看我这个客户端」和「隐藏那个客户端」就是对 `requestFid` 的简单过滤。

两点局限：

- 以旧方式**链上**注册的密钥没有 `SignedKeyRequest` 元数据，因此没有 `requestFid`，只能靠密钥本身识别。这类会退化成显示 `key:0x…`。
- 这些都**不能**证明某个真人用过某个应用。它说明的是哪把应用密钥签了这条消息——这是协议实际能支撑的最强结论。

---

## 助记词安全

客户端只会向你要一次助记词，用来授权它的应用密钥。粘贴之前，先弄清楚你交出去的是什么。

助记词推导出你的托管地址，而托管地址拥有你的 FID。拿到助记词的人可以转移 FID、更改恢复地址、添加或撤销任何密钥。没有人能替你撤回这些操作。

所以：

- **本教程请用测试账号。** 见[开始之前](#开始之前准备一个测试账号)，或者用一个丢了也不心疼的账号。跟着教程走的时候，不要把主账号助记词粘进任何东西里。
- **只把助记词粘进你信任的开发者写的软件**——最好还是你能读懂源码的软件。本客户端是开源的，接触助记词的那部分代码只有几十行。
- **优先使用委托式签名授权。** 本客户端用助记词签一份委托：生成一个应用密钥，它有权限范围（不能添加其他密钥）、30 天不用就过期，并且可以用 `KEY_REMOVE` 撤销。发帖、关注、点赞都只用这个密钥。只有在客户端里撤销该密钥时才需要再次输入助记词。
- **绝不要把助记词粘进不是你自己启动的网页。** 本客户端默认只绑定 `127.0.0.1`，正是为此。如果你传了 `--bind 0.0.0.0`，你就把助记词输入框发布到了你的整个局域网。
- **用完的密钥请撤销。** 删掉签名密钥文件并不会撤销密钥：任何有副本的人都能继续使用它，而且每用一次就延长它的寿命。请在客户端里撤销，客户端会发送 `KEY_REMOVE`。没人使用的密钥会在 30 天后过期。

---

## 故障排查

**`up` 跑了几个小时。** 首次运行这是正常的。快照有几百 GB，之后 Snapchain 还要从快照的时间点追上来。`readnode status` 会显示倒计时；`blockDelay` 变成个位数就完成了。如果倒计时很慢，检查区域：离 us-east-1 越远，每次取区块都要付出往返延迟。

**节点在同步中途挂了，磁盘满。** 你在 1 TB 的盘上用了 Snapchain 自带的快照下载器，它需要容纳第二份状态。请用 2 TB，或者让 `readnode` 来下载快照。

**某个分片的 `blockDelay` 巨大且几乎不动。** 这个分片在从创世块同步，通常是因为它的快照在 Snapchain 自带下载过程中轮换了（见「为什么硬件规格是这样」）。在节点上重新下载：

```bash
cd ~/snapchain && sudo docker compose down
sudo rm -rf .rocks && sudo readnode-snapshot "$PWD/.rocks"
sudo docker compose up -d
```

**`KEY_ADD` 因 nonce 被拒**（`nonce is not greater than stored nonce`）。 有另一条 `KEY_ADD` 或 `KEY_REMOVE` 先落地了。重新读取 `currentUserNonce` 并提交更大的值。永远不要用同一个 nonce 重试。

**`KEY_ADD` 因签名被拒。** `KeyAdd` 签名验出结果不是该 FID 的托管地址。检查你导入的助记词推导出的地址是否等于 `idOf()` 的返回值。

**`KEY_ADD` 因 metadata 被拒。** 你的 metadata 可能用了链上的 `SignedKeyRequestValidator` 域。请用 `makeKeyAddBody()` 来构造，它签的是链下域。

**`KEY_ADD` 因权限范围被拒。** `KEY_ADD` 和 `KEY_REMOVE` 永远不能作为权限范围。任何不在可接受集合内的值都会被拒。

**`mempoolSize` 是 `4294967295`。** 读取节点上这是正常的，表示「未上报」。

**帖子被接受了但一直没出现。** 你拿到的是验证通过，不是已上链。在读取节点上，消息依赖 gossip 抵达验证者。请重新提交，或者用 `--submit-url` 指向某个验证者重启客户端，以获得更强的保证。

**写入因存储被拒。** 该 FID 没有租存储。请查看 `/v1/storageLimitsByFid`。存储是在链上租的；本工具不会替你租。

**订阅者漏掉了事件。** 事件默认保留 3 天（`pruning.event_retention`）后会被清理。从早于保留窗口的事件 id 恢复的订阅者什么也拿不到，只能从消息 API 回填。

---

## 成本

在 AWS `m5.xlarge` + 2 TB gp3 上运行一周：

| 项目 | 单价 | 7 天 |
| --- | --- | --- |
| EC2 `m5.xlarge` | $0.192/小时 | $32.26 |
| EBS gp3 2 TB | $0.08/GB-月 | $37.71 |
| 公网 IPv4 | $0.005/小时 | $0.84 |
| 快照下载 | 入站免费 | $0.00 |
| **合计** |  | **约 $70** |

存储按自然日计费，与实际用量无关，所以它占大头；而且实例停掉之后它照样在计费。让它跑满一个月，光这个卷就是 $164。用完请删除卷。

短周期运行更便宜的做法：

- **GCP**——同样规格的机器换用 `pd-standard`，$0.04/GB-月 而不是 $0.08。一周约 **$52**。
- **Spot EC2**——约 $0.07/小时，但有被中断的风险。这里之所以能接受，只是因为数据库在 EBS 上而不是实例存储上。
- **只跑三天而不是七天**——约 **$30**。同步耗时是几小时而不是几天，节点没必要整周存在。

要盯的是磁盘，不是 CPU。

---

## 官方文档哪里滞后了

写这份教程期间有两处过时，上面都已更正：

1. `snapchain.farcaster.xyz/guides/writing-messages` 自己注明：它链接的 `hello-world` 示例**仍然通过 key gateway 在链上注册签名密钥**。该指南第 3 步的免 gas 流程取代了它，且不需要 ETH。
2. `GetOnChainSignersByFid` 只返回链上密钥。请用 `GetSignersByFid` / `GET /v1/signersByFid`，它一次返回两类密钥，并附带 `currentUserNonce` 和每个 FID 的免 gas 密钥上限。

第 1 点对应 [`farcasterxyz/hub-monorepo`](https://github.com/farcasterxyz/hub-monorepo) 里一个仍在使用的示例。如果你读到这里时它还没改，欢迎提 pull request——那才是这个问题的正典归宿。

---

## 参考资料

悬赏帖引用的四个来源，加上取代了其中部分内容的两个页面。当本教程与实际情况不符时，以这些为准。

1. [Farcaster 架构概览](https://docs.farcaster.xyz/learn/architecture/overview)——两套系统：Optimism 上的链上注册表，Snapchain 上的消息。
2. [Hello world](https://docs.farcaster.xyz/developers/guides/basics/hello-world)——官方的第一个客户端示例。它仍然在链上注册签名密钥；见「官方文档哪里滞后了」。
3. [运行 Snapchain 节点](https://snapchain.farcaster.xyz/guides/running-a-node)——硬件、端口，以及 `readnode up` 所封装的官方安装脚本。
4. [Snapchain HTTP API](https://docs.neynar.com/snapchain/httpapi/httpapi.md)——客户端调用的每一个 `/v1/` 端点。
5. [节点类型](https://snapchain.farcaster.xyz/node-types)——读取节点 vs 验证者，以及读取节点为何会转发写入。
6. [写入消息](https://snapchain.farcaster.xyz/guides/writing-messages)——第三部分使用的免 gas `KEY_ADD` 流程。
