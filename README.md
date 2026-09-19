# DD@Home · Docker

给 DD@Home 贡献一点空闲资源。自动生成身份、断线自动重连，长期运行不需要守着终端。

支持 **Linux / macOS / Windows**：Linux 使用 Docker Engine + Compose v2；macOS、Windows 使用 Docker Desktop 的 **Linux 容器**。镜像支持 **AMD64 和 ARM64**，包括 Intel/AMD 主机与 Apple Silicon。无需安装 Node.js。

## 启动

下载本仓库，在项目目录执行这一句：

```sh
docker compose up -d
```

已安装 Git，也可以从零开始一行启动（Linux/macOS、Windows CMD 或 PowerShell 7）：

```sh
git clone https://github.com/dd-center/DDatDocker.git && cd DDatDocker && docker compose up -d
```

第一次会自动构建镜像，并生成 UUID 和类似 **`DD-Docker-linux-arm64-a1b2c3d4`** 的昵称。身份保存在数据卷中；重启、重建、升级继续使用，不用手动生成或复制 UUID。

在 [DDatElectron](https://github.com/dd-center/DDatElectron) 的在线列表中，可看到昵称、Docker 标记、架构、Node 运行时与维护版版本。这里的 `linux-arm64` 表示**容器环境**；Docker 无法自动可靠判断外面的宿主机是 macOS、Windows 还是 Linux。

查看自己的昵称和状态：

```sh
docker compose logs --tail=20
```

也可以在浏览器打开 [本机运行状态](http://localhost:9464/status)。状态页只绑定本机，不向局域网或公网开放。

## 想改昵称或贡献量？可选

在项目目录创建 `.env`，只写需要修改的值，然后再运行 `docker compose up -d`：

```dotenv
NICKNAME=示例用户的Mac-mini
LIMIT=5
HTTP_CONCURRENCY=2
```

不创建 `.env` 也能运行。[完整示例](.env.example) 中所有设置都是可选的。

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| `NICKNAME` | 自动生成并保存 | 用自己的名字和机器名，别人更容易认出你 |
| `UUID` | 自动生成并保存 | 迁移旧节点时可以填原来的 UUID；不同节点不要共用 |
| `LIMIT` | `5` | 最多维持几个直播房间；`0` 只做 HTTP 采集 |
| `HTTP_CONCURRENCY` | `2` | 同时执行的 HTTP 任务上限 |
| `INTERVAL` | `1280` | 拉取任务间隔，毫秒；调大可减少贡献量与流量 |
| `HTTP_TIMEOUT_MS` | `10000` | 单任务总超时，最多 `12000`，小于服务端 15 秒截止时间 |
| `STATUS_PORT` | `9464` | 本机状态页端口 |
| `VERBOSE` | `false` | 是否输出每个任务的结果日志 |
| `HIDE` | `false` | 不上报系统、架构和运行时版本；仍保留昵称及 UUID |
| `URL` | `wss://cluster.vtbs.moe` | 调度服务器 |

显式填写的昵称、UUID 会覆盖并保存到数据卷；以后删掉环境变量仍会保留上次身份。要重新生成身份，可先备份再删除卷里的 `identity.json`，然后重启。每个节点使用独立数据卷。

默认限制为 **192 MiB 内存、1 CPU 上限**，这不是常驻占用。最终镜像不含 npm、yarn、编译工具和测试代码，生产依赖只有 `ws`。想再轻一点可设置 `LIMIT=0`；想多贡献一些再逐步增加，观察 `docker stats`，不要一开始开无限连接。

原生双架构测试中，**仅 HTTP 模拟负载的容器内存约 22 MiB**，镜像解包约 **134–137 MiB**。直播流量和 Docker Desktop 虚拟机开销另计；[完整测量条件](docs/diagnosis.md#实测资源与可重复结果)。

## 日常操作

```sh
docker compose logs -f --tail=50    # 看日志（Ctrl+C 不会停服务）
docker compose ps                  # 看连接健康状态
docker stats                       # 看资源使用
docker compose stop                # 暂停
docker compose up -d               # 继续 / 应用新配置
git pull --ff-only                 # 更新源码
docker compose up -d               # 构建并切换到更新后的版本
docker compose down               # 删除容器，保留身份数据卷
```

`docker compose down -v` 会同时删除身份数据卷，下次启动将成为新节点。日志自动轮转，每个容器最多保留约 30 MB。

从旧镜像迁移时先停掉旧容器，避免同一 UUID 同时运行两份；需要延续统计就在 `.env` 填上原 UUID。不要直接复用旧教程中的示例 UUID。

## 怎样判断真的在工作

`/status` 会显示 `identity`、连接状态、任务计数、直播状态及内存：

- `ready`：WebSocket 和服务端业务查询均正常；没有任务时也可以正常就绪。
- `valid`：本地拿到 `code: 0` 并已提交的 HTTP 结果数量，**不是服务端确认数**。
- `failed`、`lastFailure`：HTTP 超时、接口错误等，避免把错误网页算成成功。
- `cooldownUntil`：遇到风控/限流后暂缓采集的截止时间；不会靠反复重连绕过限制。
- `relay.live` / `relay.rooms`：实际通过认证的直播连接数 / 已分配房间数。

`/healthz` 检查调度链路；`/livez` 检查进程能否响应。普通断网由客户端退避重连；真正卡死时独立 BusyBox 看门狗结束进程，由 Docker 重启。**Docker 的 `unhealthy` 标记本身不会自动重启容器。** 上游没有任务或 B 站拒绝请求时，不会通过无意义的重启制造“成功”。

直播房间使用原 DD@Home 网页端协议；B 站接口、匿名访问或认证要求可能变化。遇到拒绝会记录错误并退避，不影响 HTTP 工作，也不保证匿名客户端永远能采集所有房间。

## 开发与验证

本地开发需要 Node 24 LTS：

```sh
npm ci
npm test
npm run test:soak        # 默认两分钟，只连接本地模拟服务
npm run test:docker      # 需要 Docker；验证重连、冻结进程后的自动恢复、身份持久化和退出
npm run smoke:live       # 可选：真实服务一分钟，检查服务端记录，执行真实任务，不发聊天
```

CI 在原生 AMD64、ARM64 Linux runner 上执行测试和 Docker 实测。Docker Desktop 的宿主系统兼容性仍需要实际机器验收；容器测试不等于长期生产验证。

详细原因、证据和验证边界见 [故障诊断](docs/diagnosis.md)。[历史 Docker 教程](docs/legacy-docker.md) 留作参考，其中旧镜像不包含本次修复。

本项目沿用 [Cluster-center](https://github.com/dd-center/Cluster-center) 协议，参考 [DDatHome-nodejs](https://github.com/dd-center/DDatHome-nodejs) 的任务/转发格式及 [bilibili-live-ws](https://github.com/simon300000/bilibili-live-ws) 6.3.1 的数据包格式；相关 MIT 版权保留在 [LICENSE](LICENSE) 中。其他语言实现仅作只读比较。
