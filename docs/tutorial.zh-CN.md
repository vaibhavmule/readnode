# 从你自己的 Farcaster 节点读取数据

一个自己拥有数据的 Farcaster 客户端。节点由你运行，全程不依赖任何第三方 API。

> 本文是英文版教程的中文翻译。命令、代码、字段名保持原样，未做本地化改写。

---

## 快速开始

三条命令。前提：你已经有一个**租了存储**的 Farcaster 账号。

```bash
# 0. 准备计算资源
readnode provision --provider aws --username yourname

# 1. 安装读取节点并等待同步
readnode up

# 2. 打开客户端
readnode client
```

`readnode provision` 创建机器并装好 Docker。`readnode up` 安装 Snapchain、启动节点，并一直阻塞到节点追平链头。`readnode client` 在 `http://127.0.0.1:3939` 上提供服务——在那里导入助记词、签发应用密钥，然后就可以看信息流、发帖、关注和点赞了。

有两件事要提前知道：

- 第一次运行 `up` 会**卡住好几个小时**。它在下载并解压约 550 GB 的快照。
- 整个过程不需要任何 API key、账号或付费套餐。唯一的开销是第 0 步租的计算资源。

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

这是让 Farcaster 变得可用的关键：**你不用托管密钥签名消息**。你用一个**应用密钥**——一对独立的 Ed25519 密钥——来签名，而托管密钥只授权它一次。

```
托管密钥（以太坊、链上、需要保护）
      │  授权一次
      ▼
应用密钥（Ed25519、链下、有权限范围、会过期）
      │  签名
      ▼
帖子、关注、回应  →  Snapchain
```

选择 Ed25519 而不是 ECDSA 是刻意的：应用密钥不可能被误认成以太坊密钥，因此泄露一个应用密钥也动不了资金。被攻破的应用密钥可以发帖，但偷不走账号。

### 存储租金

写入 Snapchain 要花存储，而存储是按 FID **在链上**按「单位」租的。不同类型的消息消耗不同——发帖和点赞不是一个价，具体比例由节点告诉你：

```bash
curl 'http://127.0.0.1:3381/v1/storageLimitsByFid?fid=1'
```

它返回每个类别的 `limit` 和 `used`。

两个值得记牢的推论：

1. **存储就是协议层的限速器。** 它不是由某家公司计费的，而是协议强制的。存储用完的 FID 发消息会被拒绝，返回 `bad_request.insufficient_storage`，签名再正确也没用。
2. **这就是本教程要求「账号已经有存储」的原因。** 租存储意味着在 Optimism 上发一笔交易。本工具刻意不做这件事，因为目标是给你一个不用碰链就能运行的节点。

### Snapchain 消息

消息是链下一切的基本单位。它由三部分组成：

- **`data`**——负载。类型（`CAST_ADD`、`REACTION_ADD`、`LINK_ADD`、`USER_DATA_ADD`、`KEY_ADD`……）、作者 `fid`、时间戳、消息体。
- **`hash`**——对序列化后的 `data` 做 BLAKE3，截断到 20 字节。
- **`signature` 和 `signer`**——对 `data` 的 Ed25519 签名，以及产生它的公钥。

哈希**只对 `data` 计算**，不包含签名。当你看官方文档里的 Rust 例子、奇怪为什么签名和哈希用的是同一个字节数组时，原因就在这里：确实同一个数组，签名是在之后附加的。

时间戳是**自 Farcaster 纪元**（2021-01-01 00:00:00 UTC）起的秒数，不是 Unix 时间。像 `48994466` 这样的原始值其实是一个正常的近期时间戳；打印时要先加上 `1609459200`。

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
| Gossip 主题 | `consensus`、`mempool`、`contact-info` | `read-node-peers`、`mempool`、`contact-info` |
| 验证者集合 | 从链上配置注册表拉取 | 静态，来自 `validators.toml` |
| `/v1/info` 中的 `mempoolSize` | 真实的每分片计数 | `4294967295`，表示「未上报」 |
| 重启它 | 会让每个分片少一票，直到它回来 | 随时安全 |
| 典型部署方式 | 运营方自行管理 | `snapchain.sh` |

验证者需要持有**验证者集合**中的密钥，而这是需要许可的——主网只有七个，不是你想加入就能加入。读取节点则是任何人都能运行的角色：它订阅已决区块，对照验证者集合验证提交证书，应用它们，并对外提供 API。状态相同，稍微落后，不参与投票。

这就是本教程采用这个角色的原因，也是它随时可重启的原因：不会干扰共识。

### 读取节点接受写入，但没有 mempool

这是系统中最微妙的部分，而旧文档在两个方向上都写错了。

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

**16 GB 内存 / 4 CPU。** 节点把主网全量状态放在 RocksDB 里。同步是内存和 IO 密集型的，不是 CPU 密集型。

**2 TB 磁盘。** 这一条最让人意外，因为数据库比这小得多：

```bash
curl -s localhost:3381/v1/info | jq '.dbStats.approxSize'
# 约 548 GB
```

`~/snapchain` 下有两个目录：

| 路径 | 作用 |
| --- | --- |
| `.rocks/` | 数据库 |
| `.rocks.snapshot/` | 下载与解压快照的临时空间 |

快照以压缩分块的形式到达，并且就地解压，所以峰值占用大约是状态大小的**两倍**——约 1.1 TB。1 TB 的盘会在下载中途被塞满，节点随即以一个毫无帮助的错误挂掉。第二个 TB 不是为增长预留的余量，而是完成第一次同步的必需条件。

**端口。** 三个端口都必须能从公网访问：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 3381 | TCP | HTTP API |
| 3382 | UDP | gossip，基于 QUIC 的 libp2p |
| 3383 | TCP | gRPC API |

`3382/UDP` 是对等互联最关键的、也是最容易被漏掉的——因为它既不是 TCP，也不是你永远不会去 `curl` 的端口。只开放 TCP 的节点能同步，但无法正常对等互联。如果你同时处在云防火墙和主机防火墙后面，两边都要放开。

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

客户端接收 BIP-39 助记词并推导出托管地址。它从助记词里只需要这个信息，并且只保存在内存中——从不落盘。

有了托管地址，它用一个公开的 RPC 端点（无需密钥）在 Optimism 上查出你的 FID，再确认 `custodyOf(fid)` 就是同一个地址。如果不是，请立刻停下：你正准备在一个你并不控制的账号上授权密钥。

### 第 2 步 —— 签发应用密钥

过去这一步需要向 `KeyGateway.add()` 发一笔 Optimism 交易。现在不需要了。Snapchain 接受**免 gas 签名密钥**：你只要向节点提交一条 `KEY_ADD` 消息就完成注册。没有交易，没有 gas，大约一秒。

`KEY_ADD` 特殊之处在于它携带**两个 EIP-712 签名，外加消息信封自身的签名**，各司其职：

1. **`SignedKeyRequest`，来自发起请求的应用。** 把应用的 `requestFid` 和密钥绑定，从而应用无法冒充其他应用的身份。它以 ABI 编码形式放进消息体的 `metadata` 字段。
2. **`KeyAdd`，来自接收密钥的 FID 的托管地址。** 这才是真正的授权。它覆盖了**权限范围、TTL 和 nonce**，所以这三者在传输途中都无法被篡改。
3. **信封签名**，由新的 Ed25519 密钥自己产生——证明提交 `KEY_ADD` 的人确实持有对应私钥。这也是 `KEY_ADD` 能豁免「签名者必须已注册」检查的原因：它是唯一一种用它自己签名的东西来创建它自己的消息类型。

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

`KEY_ADD` 和 `KEY_REMOVE` **永远**不能作为权限范围。签名者不能铸造或撤销另一个签名者——如果允许，一个泄露的应用密钥就能给自己签发无限个后继密钥。链上签名者早于范围机制，因此永久保持无范围。

**滑动 TTL。** 每个密钥的 TTL 最长 90 天，并且每次签署一条被合并的消息时就刷新。活跃使用的密钥会一直存活，被弃用的密钥会自行过期。你不需要特意去撤销不再使用的密钥。

**Nonce。** 每个 FID 有一个单调递增的用户 nonce。每条 `KEY_ADD` 携带的 nonce 必须严格大于该 FID 的当前值，这让被截获的授权无法重放。先读当前值：

```bash
curl 'http://127.0.0.1:3381/v1/signersByFid?fid=<你的fid>' | jq '.currentUserNonce'
```

然后提交 `currentUserNonce + 1`。如果你要写重试逻辑：**重试必须重新读取 nonce。** 重放同一条已签名的 `KEY_ADD` 会失败并返回 `nonce is not greater than stored nonce`，沿用旧值的重试同样会失败。

请使用 `GET /v1/signersByFid`。旧的 `GetOnChainSignersByFid` 只返回链上密钥，已废弃——对于只有免 gas 密钥的账号，它会返回空列表，这是一种非常容易浪费一下午的困惑来源。

单个 FID 最多可持有 1000 个活跃的免 gas 密钥，与链上密钥分开计数。免 gas 签名密钥自引擎版本 **V16** 起在主网可用。

### 第 3 步 —— 读、发帖、关注、点赞

读走你自己的节点：

```bash
curl 'http://127.0.0.1:3381/v1/castsByFid?fid=<你的fid>&pageSize=10&reverse=true'
curl 'http://127.0.0.1:3381/v1/userDataByFid?fid=<你的fid>'
curl 'http://127.0.0.1:3381/v1/linksByFid?fid=<你的fid>&link_type=follow'
curl 'http://127.0.0.1:3381/v1/reactionsByCast?target_fid=<对方fid>&target_hash=0x…&reaction_type=Like'
```

常用参数：`pageSize`、`pageToken`、`reverse=1`，以及部分端点支持 `startTimestamp` / `stopTimestamp`。分页基于 token——沿着 `nextPageToken` 一直取到空为止。

写操作是：构造消息、用应用密钥签名、序列化，然后以原始 protobuf 字节 POST 出去：

```bash
curl -X POST http://127.0.0.1:3381/v1/submitMessage \
  -H 'content-type: application/octet-stream' \
  --data-binary @message.encoded.protobuf
```

`Message.encode(msg).finish()` 产生这些字节。注意 content type：它**不是** JSON，发 JSON 是这里最常见的错误。

### 第 4 步 —— 按客户端过滤信息流

Farcaster 不把客户端名字写进消息，那怎么知道一条帖子是哪个应用发的？

这个问题有真正的答案，不是启发式猜测。每条帖子都由某个应用密钥签名，而每个**免 gas** 应用密钥都带有 `requestFid`——就是申请该密钥的应用的 FID，来源是注册密钥时被验证过的 `SignedKeyRequest` 元数据。

所以链路是：`cast.signer` → 作者的密钥列表 → `requestFid` → 哪个客户端。

```bash
curl 'http://127.0.0.1:3381/v1/signersByFid?fid=<作者fid>' | jq '.signers[] | {key, requestFid, scopes, expiresAt}'
```

客户端会为你信息流里的每个作者解析这些信息，并给每条帖打上标签。于是「只看我这个客户端」和「隐藏那个客户端」就是对 `requestFid` 的简单过滤。

两点诚实的说明：

- 以旧方式**链上**注册的密钥没有 `SignedKeyRequest` 元数据，因此没有 `requestFid`，只能靠密钥本身识别。这类会退化成显示 `key:0x…`。
- 这些都**不能**证明某个真人用过某个应用。它说明的是哪把应用密钥签了这条消息——这是协议实际能支撑的最强结论。

---

## 助记词安全

客户端只会向你要一次助记词，用来授权它的应用密钥。粘贴之前，先弄清楚你交出去的是什么。

助记词推导出你的托管地址，而托管地址拥有你的 FID。拿到助记词的人可以转移 FID、更改恢复地址、添加或撤销任何密钥。没有人能替你撤回这些操作。

所以：

- **本教程请用测试账号。** 注册一个一次性 FID，或者用一个丢了也不心疼的账号。跟着教程走的时候，不要把主账号助记词粘进任何东西里。
- **只把助记词粘进你信任的开发者写的软件**——最好还是你能读懂源码的软件。本客户端是开源的，接触助记词的那部分代码只有几十行。你交给这些词的任何软件都应该满足这一点，而通常并不满足。
- **优先使用委托式签名授权。** 本客户端用助记词签一份委托：生成一个应用密钥，它有权限范围（不能添加其他密钥）、90 天不用就过期，并且可以用 `KEY_REMOVE` 撤销。发帖、关注、点赞都只用这个密钥。只有在客户端里撤销该密钥时才需要再次输入助记词。
- **绝不要把助记词粘进不是你自己启动的网页。** 本客户端默认只绑定 `127.0.0.1`，正是为此。如果你传了 `--bind 0.0.0.0`，你就把助记词输入框发布到了你的整个局域网。
- **不用的密钥会自己过期。** 你不必记得清理。删掉签名密钥文件就够了，密钥会在 TTL 到期后自行死亡。

---

## 故障排查

**`up` 跑了几个小时。** 首次运行这是正常的。快照有几百 GB。`readnode status` 会显示倒计时；`blockDelay` 变成个位数就完成了。

**节点在同步中途挂了，磁盘满。** 你用了 1 TB 的盘。快照临时目录需要容纳第二份状态。请用 2 TB。

**`nonce is not greater than stored nonce`。** 有另一条 `KEY_ADD` 或 `KEY_REMOVE` 先落地了。重新读取 `currentUserNonce` 并提交更大的值。永远不要用同一个 nonce 重试。

**`KEY_ADD` 报 `invalid signature`。** `KeyAdd` 签名验出结果不是该 FID 的托管地址。检查你导入的助记词推导出的地址是否等于 `idOf()` 的返回值。

**`invalid signed key request`。** 你的 metadata 用了链上的 `SignedKeyRequestValidator` 域。请用 `makeKeyAddBody()` 来构造，它签的是链下域。

**`invalid scope`。** `KEY_ADD` 和 `KEY_REMOVE` 永远不能作为权限范围。任何不在可接受集合内的值都会被拒。

**`mempoolSize` 是 `4294967295`。** 读取节点上这是正常的，表示「未上报」。

**帖子被接受了但一直没出现。** 你拿到的是验证通过，不是已上链。在读取节点上，消息依赖 gossip 抵达验证者。请重新提交，或者用 `--submit-url` 指向某个验证者重启客户端，以获得更强的保证。

**`bad_request.insufficient_storage`。** 该 FID 在对应类别的存储用完了。存储是在链上租的；本工具不会替你租。

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
