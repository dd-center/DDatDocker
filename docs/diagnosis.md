# 长期运行故障诊断

检查日期：2026-09-19。没有原故障机器的日志，因此不能把某一项缺陷断言成那台机器掉线的唯一原因。下面分别记录源码确认、可复现故障与生产环境待验证项。

## 已确认的问题

### NodeJS：fd0342242608e10631c4a3e2fe9d2424feab30c9

[core.js](https://github.com/dd-center/DDatHome-nodejs/blob/fd0342242608e10631c4a3e2fe9d2424feab30c9/core.js) 中：

1. HTTP fetch 没有总超时，拉任务循环又没有并发上限。慢响应、长时间读取 body 时工作会堆积；服务端却已经按 15 秒截止时间判失败。
2. message 回调直接解析、解构 JSON。无效 JSON、`null` 会抛出未捕获异常。
3. `opts.dispatcher = dispatcher` 引用未定义变量，配置 dispatcher 时发生未处理的 Promise 拒绝。
4. HTTP 结果通过可变的 `this.ws` 发送。旧会话中的请求晚完成时，会被发到新连接；服务端的任务 key 属于旧连接，结果不再有效。
5. 没有握手超时设置，也没有业务层探活。ping/pong 可以检验链路，不能检验服务端是否还在处理请求。原来的心跳超时使用 close 握手，而不是立即销毁失效连接。
6. `secureSend` 没有发送缓冲区上限或发送回调错误处理。`stop()` 不取消正在进行的 HTTP 请求和查询。

[relay.js](https://github.com/dd-center/DDatHome-nodejs/blob/fd0342242608e10631c4a3e2fe9d2424feab30c9/relay.js) 中：

- 房间默认上限为 Infinity，连接数可持续增加。
- `getConf` 失败后反复放回队列，没有单房间取消、HTTP 超时和完整停机清理。
- 一个房间失败导致 `rooms.size !== lived.size`，会阻止继续挑选新房间。
- `KeepLiveWS(roomid, options)` 的可变参数数组是 `[roomid, options]`，但关闭回调写 `live.params[2]`，没有更新真正的 `options`；重连可能继续使用过期 token。
- 6.3.1 依赖把底层 `error` 转发成 `e`，外层却监听 `error`。依赖的异步解码异常也没有完整接住。

本维护版没有继续使用依赖内部的无限重连器。保留协议格式，以有上限、可取消的房间状态管理和带长度/解压预算的解码实现替代。

可复现其中四项（只读取原源码，隔离直播，不访问生产服务）：

```sh
node scripts/reproduce-upstream.js /path/to/DDatHome-nodejs/core.js
```

### 服务端：391dce799f2489ab0e966000e3ca1c4f71d559ef

[ws.ts](https://github.com/dd-center/Cluster-center/blob/391dce799f2489ab0e966000e3ca1c4f71d559ef/src/ws.ts) 每个任务 15 秒超时，任务 key 和待完成表属于连接。断线后不能把旧结果发给新连接。

[metadata.ts](https://github.com/dd-center/Cluster-center/blob/391dce799f2489ab0e966000e3ca1c4f71d559ef/src/metadata.ts) 的 Balancer 会按最近失败比例随机忽略 `DDDhttp`。所以“没有收到任务”不能直接判定断线，更不能无限重连规避调度。本维护版用 `online` 查询验证业务可用性。

### 其他客户端与 Docker 文档

| 项目 | 本次检查到的具体情况 |
| --- | --- |
| Electron | `src/ws.js` 直接使用 NodeJS 核心；界面提供在线列表和统计，不是独立于核心的可靠性保障。 |
| Go | HTTP DefaultClient 无总超时，WebSocket Read 无截止时间；首次连接失败 panic；主要依赖下一次写失败触发重连，读操作卡死时到不了那里。没有直播采集。 |
| Python | `close()` 的 `(t.set_closed() for t in self.tasks)` 和 `(t.join() for t in self.tasks)` 只构造生成器，未执行；线程还可阻塞在 Queue.get。connect 上下文建立失败在重试捕获范围之外。 |
| Java/Kotlin | `DistributionProcessor.sendTo()` 的 while(true) 成功发送后没有 return/break，会持续重复发送。服务 `start()` 只调用一次 distribute 后 delay，没有循环。 |
| DDatDocker 旧文档 | `--restart=always` 只能处理退出，不能修复进程假活；自建示例 tag 是 `ddathomenodejs`，后面却仍运行上游镜像。示例固定 UUID 也容易被多人复用。 |

以上均为只读检查；只有 DDatDocker 被修改，其他仓库没有提交改动。

## 维护版的恢复边界

- HTTP 在 10 秒总超时内完成或报告失败；只允许有限并发，不积压无界任务队列。
- HTTP 响应大小、WebSocket 收发大小、解压后数据、直播消息队列都有上限。
- 关闭连接时取消任务和查询；旧请求永远不能通过新会话发送。
- WebSocket 握手、pong 和业务查询分别有超时；重连使用带随机抖动的指数退避，稳定运行后重置退避。
- 不把 HTML、HTTP 错误或 B 站非零返回码算成功；限流引发冷却，连接保持正常。
- 直播配置失败、认证失败、缺少心跳、坏数据只影响对应房间，并有重试间隔。
- 默认每分钟输出一次状态，错误始终可见；暴露真实计数而非只有进程 PID。
- 容器内用一个 Node 工作进程和 BusyBox 看门狗。看门狗请求 `/livez`；卡死超过 45 秒便终止进程，交给 Docker 的 restart policy。`/healthz` 只表示调度链路就绪。
- UUID 与昵称以原子写入保存到独立命名卷，容器重建不丢身份。

## 验证说明

自动测试覆盖：正常采集、服务端关闭、WebSocket 假活、服务端业务假活、握手卡住、HTTP headers/body 卡住、容量限制、无效响应、限流、发送缓冲耗尽、旧任务隔离、停机清理、直播认证和转发、压缩帧解析、身份生成与持久化。

`test:soak` 是**本地加速故障注入**，有意频繁断线和制造慢请求。它不能证明运行数周没有泄漏，也不应用其内存值代表生产容器占用（模拟服务与客户端在同一进程里）。`test:docker` 在独立模拟服务旁运行容器，输出容器的实际资源用量和镜像大小。

还需以实际部署环境进行至少 24–72 小时观察：记录 `valid` 是否继续增长、服务器成功计数、断线恢复时间、内存趋势及直播失败原因。空闲、B 站接口变动或风控不是客户端自动重启能够解决的；新版会如实暴露这些情况。
