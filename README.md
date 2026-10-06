# better-dsh-web-restart

DSH（DeepSeek Harness）Web 的重启按钮 + 在线状态灯插件。前身 `dsh-web-restart` 数次静默失效后重写，主打三点：**自动恢复、无感刷新、与其他插件无冲突**。

![status] 会话顶栏「⋯」菜单**左侧**：一颗状态灯 + 一个重启按钮。

## 特点

- **自动恢复**：重启走「延迟 kill → systemd 自愈」——`kill -9` 掉 `dsh-web.service` 的 MainPID 后由 `Restart=on-failure + RestartSec=3` 自动拉起，6~8 秒 HTTP 就绪，全程不需要人工介入；状态灯掉线时 1 秒快轮询、在线时 3 秒慢轮询，服务回来自动转绿。
- **无感刷新**：不需要手动 F5。页面里的轮询探针只认 `/restart-dsh/status` 的真实响应，服务就绪的瞬间灯就转绿、按钮恢复可用；倒计时归服务端所有，刷新页面也不丢排程状态。
- **与其他插件无冲突**：纯增量接入——槽位用 `ctx.slots.inject` + 独立 entry id 注册、字典独占 `betterDshWebRestart` 命名空间、HTTP 路由只占用 `/restart-dsh/*` 三个精确路径，不改写任何共享状态；卸载时路由和排程一并清理（`ctx.effect` 生命周期）。

## 安装

```bash
git clone https://github.com/kids0cn/better-dsh-web-restart.git
```

在 DSH 会话里让 agent 执行 `plugin_manager install_bundle`，target 指向克隆目录；或手动把目录软链进 profile 后在 `cordis.patch.yml` 插入：

```yaml
- insert:
    - id: better-dsh-web-restart
      name: '@local/better-dsh-web-restart'
```

安装后**刷新一次页面**加载 client 半区即可。

## 使用

- **灯**：绿 = 服务在线，红 = 掉线（含重启窗口期）。
- **按钮**：点一下 → 倒计时（默认 45s，本仓库预设为 5s）→ 到点自动重启；倒计时中再点一下 = 取消。
- ⚠️ `kill -9` 切的是整个 cgroup：**点击时正在流式输出的所有会话回复都会被切断**，确认没有在途任务再点。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/restart-dsh/status` | `{ ok, service, armed, killAt }`，兼作存活探针 |
| POST | `/restart-dsh/arm?delay=N` | 排程重启，delay 钳位 5~600 秒，缺省 45 |
| POST | `/restart-dsh/cancel` | 取消排程 |

跨站 `Origin` 请求返回 403（防恶意网页 CSRF 触发重启）。

## 文件结构

```
index.js          Host 半区：三个 HTTP 路由 + 延迟杀手进程（detached，自持会话组）
client.js         Client 半区：槽位注册、状态灯轮询、按钮倒计时
cordis.patch.yml  bundle patch
locale/           插件管理器显示文案（zh/en）
```

## 重启机制（为什么这样杀）

```bash
# 插件等价于执行（delay 秒后）：
kill -9 $(systemctl show dsh-web.service -p MainPID --value)
# systemd 见 failure → RestartSec=3 → 自动拉起 → 6~8s HTTP 就绪
```

- 杀手进程 `detached` 自成会话组，**能活着送出那一刀**（它就在将死的 cgroup 里）；
- `cancel` 杀整个进程组，不留 `sleep` 残骸；
- 服务端持 `killAt`，页面刷新、多标签页状态一致。

## 已知取舍

- 延迟是**回复保护**：agent 进程与服务同 cgroup，立即 kill 会切断正在输出的回复。延迟越短体感越快、丢回复风险越高——本仓库默认 5s（用户拍板），追求稳妥可改 `client.js` 里的 `delay=5`。
- 重启瞬间所有在跑的会话任务一起中断，这是 `kill -9` + systemd 方案的固有代价。

## License

MIT
