#!/usr/bin/env bash
# RecallFlow 本地开发启动器：一条命令把「MCP server（默认 7801）」拉起来，
# 需要时再顺带把某个目录挂成「本地静态服务（默认 8099）」——用来调试本地 HTML。
#
# 为什么需要一个脚本（而不是一行 node 命令）：
#   1. MCP server 必须**常驻单实例**：7801 上只能有一个进程与扩展保持桥接，
#      多起一个会 EADDRINUSE 直接退出；所以启动前必须判断"是不是已经有一个在跑"。
#   2. 它的启动姿势有一串容易漏的参数：`--http`、端口、token、证据目录、扩展超时。
#   3. 调试本地 HTML 又必须先有 127.0.0.1 站点（扩展的 content_scripts 只匹配 http/https，
#      不注入 file:// 页面）——这两个服务都要"开着不动"，所以合并成一个可 status/stop 的入口。
#
# 用法：
#   bash scripts/dev-up.sh                      # 前台：起 MCP server，Ctrl-C 停止本次启动的进程
#   bash scripts/dev-up.sh --with-static        # 同时把当前目录挂成 http://127.0.0.1:8099
#   bash scripts/dev-up.sh --with-static docs   # 指定目录
#   bash scripts/dev-up.sh --daemon             # 后台常驻（配合 status / stop / logs）
#   bash scripts/dev-up.sh status               # 谁在跑、端口、健康检查
#   bash scripts/dev-up.sh stop                 # 停掉 7801/8099 上的服务（非本项目进程需 --force）
#   bash scripts/dev-up.sh logs                 # 跟踪两个服务的日志
#
# 环境变量（都可覆盖）：
#   RECALLFLOW_MCP_PORT         MCP/桥接端口（默认 7801）
#   RECALLFLOW_BRIDGE_TOKEN     桥接 token（不设则用内置默认值，server 会自己打印警告）
#   RECALLFLOW_EVIDENCE_DIR     证据归档目录（默认 ~/.recallflow-evidence）
#   RECALLFLOW_EXT_TIMEOUT_MS   等待扩展响应超时（默认 60000）
#   STATIC_PORT / STATIC_ROOT   静态服务端口 / 目录
#
# Windows 提示：本脚本在 Git Bash 下工作（WSL 里 node 与 D: 路径的映射不同，未验证）。
# 原生 cmd/PowerShell 用 scripts/dev-up.cmd，它只是转发到这里，逻辑只有这一份。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_DIR="$ROOT/integrations/opencode/recallflow-mcp"
MCP_ENTRY="$MCP_DIR/index.js"
SERVE_ENTRY="$SCRIPT_DIR/serve-dir.mjs"
OUT_DIR="$ROOT/scripts/out/dev-up"
MCP_LOG="$OUT_DIR/mcp.log"
STATIC_LOG="$OUT_DIR/static.log"

MCP_PORT="${RECALLFLOW_MCP_PORT:-7801}"
STATIC_PORT="${STATIC_PORT:-8099}"
STATIC_DIR="${STATIC_ROOT:-}"
WITH_STATIC=0
DAEMON=0
FORCE=0
CMD="up"

info() { printf '[dev-up] %s\n' "$*"; }
warn() { printf '[dev-up] ! %s\n' "$*" >&2; }
die() { printf '[dev-up] x %s\n' "$*" >&2; exit 1; }

is_windows() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW* | MSYS* | CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- 参数解析 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    up | start) CMD="up" ;;
    stop) CMD="stop" ;;
    status) CMD="status" ;;
    logs | log) CMD="logs" ;;
    --with-static)
      WITH_STATIC=1
      # 允许 `--with-static <dir>`（后一个参数不是 -- 开头时当作目录）
      if [ $# -ge 2 ] && [ "${2#--}" = "$2" ]; then
        STATIC_DIR="$2"
        shift
      fi
      ;;
    --static-dir)
      shift
      [ $# -ge 1 ] || die "--static-dir 缺少取值"
      STATIC_DIR="$1"
      WITH_STATIC=1
      ;;
    --port)
      shift
      [ $# -ge 1 ] || die "--port 缺少取值"
      MCP_PORT="$1"
      ;;
    --static-port)
      shift
      [ $# -ge 1 ] || die "--static-port 缺少取值"
      STATIC_PORT="$1"
      ;;
    --daemon | -d) DAEMON=1 ;;
    --force) FORCE=1 ;;
    -h | --help) CMD="help" ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
  shift
done

if [ "$CMD" = "help" ]; then
  cat <<'USAGE'
RecallFlow 本地开发启动器

用法：
  bash scripts/dev-up.sh                      前台起 MCP server（Ctrl-C 停止本次启动的进程）
  bash scripts/dev-up.sh --with-static [DIR]  同时把 DIR（默认当前目录）挂成 http://127.0.0.1:8099
  bash scripts/dev-up.sh --daemon             后台常驻
  bash scripts/dev-up.sh status               查看端口/进程/健康检查
  bash scripts/dev-up.sh stop [--force]       停止 7801 / 8099 上的服务
  bash scripts/dev-up.sh logs                 跟踪日志

可选参数：--port N（MCP 端口，默认 7801）、--static-port N（默认 8099）、--force

环境变量：RECALLFLOW_MCP_PORT / RECALLFLOW_BRIDGE_TOKEN / RECALLFLOW_EVIDENCE_DIR /
          RECALLFLOW_EXT_TIMEOUT_MS / STATIC_PORT / STATIC_ROOT
USAGE
  exit 0
fi

if [ "$WITH_STATIC" = "1" ]; then
  [ -n "$STATIC_DIR" ] || STATIC_DIR="$PWD"
  [ -d "$STATIC_DIR" ] || die "静态目录不存在：$STATIC_DIR"
  STATIC_DIR="$(cd "$STATIC_DIR" && pwd)"
fi

# ---------- 端口 / 进程工具 ----------
# 找监听某端口进程的 **系统 PID**。
# 为什么不用 pid 文件作准：Git Bash 里 `$!` 给的是 MSYS 自己的 pid，
# 换一个 shell 就失去意义；而端口归属是跨会话稳定的真值。
port_owner() {
  local port="$1"
  if is_windows; then
    # `|| true` 不是装饰：本脚本开了 set -e + pipefail，而 netstat/awk 在
    # "没有匹配"或异常退出时会给非零状态，直接把调用方（尤其是 trap）带崩。
    netstat -ano 2>/dev/null | awk -v p=":$port" \
      '$1=="TCP" && $4=="LISTENING" && substr($2, length($2)-length(p)+1)==p {print $5; exit}' || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print $NF}' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n1 || true
  fi
  return 0
}

pid_cmdline() {
  local pid="$1" ps=""
  if is_windows; then
    for c in powershell.exe pwsh.exe pwsh; do
      if command -v "$c" >/dev/null 2>&1; then
        ps="$c"
        break
      fi
    done
    if [ -z "$ps" ]; then
      return 0
    fi
    "$ps" -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\").CommandLine" 2>/dev/null | tr -d '\r' || true
  else
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true
  fi
}

# 只回收"看起来确实是本项目的进程"：避免 stop 误杀用户手动起的别的服务。
is_project_process() {
  local cmd="$1"
  case "$cmd" in
    *serve-dir.mjs*) return 0 ;;
    *recallflow-mcp*index.js*) return 0 ;;
    *index.js*--http*) return 0 ;;
    *) return 1 ;;
  esac
}

kill_pid() {
  local pid="$1"
  if is_windows; then
    taskkill //PID "$pid" //F >/dev/null 2>&1 || true
  else
    kill "$pid" 2>/dev/null || true
  fi
}

wait_http() {
  local url="$1" tries="${2:-40}"
  node -e '
    const url = process.argv[1];
    const tries = Number(process.argv[2]);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      for (let i = 0; i < tries; i += 1) {
        try {
          const r = await fetch(url);
          if (r.status < 500) { process.stdout.write(await r.text()); process.exit(0); }
        } catch (e) {}
        await sleep(500);
      }
      process.exit(1);
    })();
  ' "$url" "$tries"
}

find_free_port() {
  local start="$1" p
  for p in $(seq "$start" $((start + 10))); do
    [ -z "$(port_owner "$p")" ] && {
      echo "$p"
      return 0
    }
  done
  return 1
}

# 仅用于展示：Git Bash 下的 /d/foo 换成 D:\foo，Windows 用户才认得出是哪个目录。
win_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

require_node() {
  command -v node >/dev/null 2>&1 || die "找不到 node（本脚本需要 Node 18+）"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 18 ] 2>/dev/null || die "Node 版本过低（需要 18+，当前 $(node -v 2>/dev/null))"
}

require_mcp_deps() {
  [ -f "$MCP_ENTRY" ] || die "找不到 MCP 入口：$MCP_ENTRY"
  [ -d "$MCP_DIR/node_modules/@modelcontextprotocol/sdk" ] ||
    die "MCP 依赖未安装：cd \"$MCP_DIR\" && npm ci"
}

# ---------- 各命令 ----------
STARTED_MCP=0
STARTED_STATIC=0
# 启动成功后按端口反查到的**系统 PID**，供 Ctrl-C 回收时直接用：
# 信号处理里再去 fork netstat/PowerShell 既慢又容易被下一次 Ctrl-C 打断。
MCP_OWNER_PID=""
STATIC_OWNER_PID=""

# 按记录下来的 PID 回收（不再查端口）。清理路径要尽量少依赖外部命令。
kill_recorded() {
  local pid="$1" label="$2" port="$3"
  if [ -z "$pid" ]; then
    info "$label（端口 $port）：没记下 PID，未自动回收（用 stop 子命令手动收）。"
    return 0
  fi
  kill_pid "$pid"
  info "已停止 $label（端口 $port，pid $pid）"
  return 0
}

print_summary() {
  local mcp_pid static_pid health
  mcp_pid="$(port_owner "$MCP_PORT")"
  printf '\n──────────────────────────────────────────────────────────\n'
  if [ -n "$mcp_pid" ]; then
    health="$(wait_http "http://127.0.0.1:$MCP_PORT/health" 3 2>/dev/null || echo '(健康检查无响应)')"
    printf ' MCP server   http://127.0.0.1:%s/mcp   pid %s\n' "$MCP_PORT" "$mcp_pid"
    printf '              健康检查 %s\n' "$health"
  else
    printf ' MCP server   http://127.0.0.1:%s/mcp   （未运行）\n' "$MCP_PORT"
  fi
  if [ "$WITH_STATIC" = "1" ]; then
    static_pid="$(port_owner "$STATIC_PORT")"
    if [ -n "$static_pid" ]; then
      printf ' 静态服务     http://127.0.0.1:%s/      pid %s  root=%s\n' "$STATIC_PORT" "$static_pid" "$(win_path "$STATIC_DIR")"
    else
      printf ' 静态服务     http://127.0.0.1:%s/      （未运行）\n' "$STATIC_PORT"
    fi
  fi
  printf '──────────────────────────────────────────────────────────\n'
  printf ' 接入 DSH / opencode（url + 同一个 token）：\n'
  printf '   url    : http://127.0.0.1:%s/mcp\n' "$MCP_PORT"
  printf '   header : X-RecallFlow-Token: %s\n' "${RECALLFLOW_BRIDGE_TOKEN:-<内置默认值 recallflow-local-bridge-v1>}"
  if [ "$WITH_STATIC" = "1" ]; then
    printf ' 调试本地 HTML：浏览器打开 http://127.0.0.1:%s/ 后，browser_read / page_health 即可用\n' "$STATIC_PORT"
  fi
  printf ' 日志：%s\n' "$(win_path "$OUT_DIR")"
  local stop_hint="bash scripts/dev-up.sh stop"
  if [ "$MCP_PORT" != "7801" ]; then
    stop_hint="$stop_hint --port $MCP_PORT"
  fi
  if [ "$STATIC_PORT" != "8099" ]; then
    stop_hint="$stop_hint --static-port $STATIC_PORT"
  fi
  printf ' 停止：%s\n\n' "$stop_hint"
}

cmd_up() {
  require_node
  require_mcp_deps
  mkdir -p "$OUT_DIR"
  export RECALLFLOW_MCP_PORT="$MCP_PORT"

  local mcp_pid
  mcp_pid="$(port_owner "$MCP_PORT")"
  if [ -n "$mcp_pid" ]; then
    info "端口 $MCP_PORT 已有服务（pid $mcp_pid），复用它，不重复启动。"
    info "  命令：$(pid_cmdline "$mcp_pid" | cut -c1-120)"
  else
    info "启动 MCP server：node index.js --http（端口 $MCP_PORT）"
    printf '\n===== %s 启动 =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$MCP_LOG"
    # 千万别写成 `(cd "$MCP_DIR" && nohup ... &)`：那个子 shell 会**一直持有 stdout 的写端**，
    # 于是任何把本脚本输出接进管道的调用方（`| tee`、`| cat`）都会永远等不到 EOF
    # （实测挂住到超时 rc=124；去掉子 shell 后立刻正常）。MCP server 不依赖 cwd
    # （证据目录取 RECALLFLOW_EVIDENCE_DIR 或 ~/.recallflow-evidence），入口又是绝对路径。
    nohup node "$MCP_ENTRY" --http >>"$MCP_LOG" 2>&1 </dev/null &
    STARTED_MCP=1
    if wait_http "http://127.0.0.1:$MCP_PORT/health" 40 >/dev/null; then
      MCP_OWNER_PID="$(port_owner "$MCP_PORT" || true)"
      info "MCP server 就绪（/health 200）"
    else
      warn "MCP server 未在 20s 内就绪，最后几行日志："
      tail -n 15 "$MCP_LOG" >&2 || true
    fi
  fi

  if [ "$WITH_STATIC" = "1" ]; then
    local static_pid
    static_pid="$(port_owner "$STATIC_PORT")"
    if [ -n "$static_pid" ]; then
      local free
      if free="$(find_free_port $((STATIC_PORT + 1)))"; then
        warn "端口 $STATIC_PORT 已被 pid $static_pid 占用，静态服务改用 $free"
        STATIC_PORT="$free"
      else
        die "端口 $STATIC_PORT 及其后 10 个端口都被占用"
      fi
    fi
    [ -f "$SERVE_ENTRY" ] || die "找不到静态服务入口：$SERVE_ENTRY"
    info "启动静态服务：$STATIC_DIR → http://127.0.0.1:$STATIC_PORT/"
    printf '\n===== %s 启动 =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$STATIC_LOG"
    nohup node "$SERVE_ENTRY" --root "$STATIC_DIR" --port "$STATIC_PORT" >>"$STATIC_LOG" 2>&1 </dev/null &
    STARTED_STATIC=1
    if wait_http "http://127.0.0.1:$STATIC_PORT/" 20 >/dev/null; then
      STATIC_OWNER_PID="$(port_owner "$STATIC_PORT" || true)"
      info "静态服务就绪"
    else
      warn "静态服务未在 10s 内就绪，最后几行日志："
      tail -n 15 "$STATIC_LOG" >&2 || true
    fi
  fi

  print_summary

  if [ "$DAEMON" = "1" ]; then
    info "已后台常驻（用 status / logs / stop 管理）"
    return 0
  fi

  # 前台：跟随日志，Ctrl-C 只回收"本次启动"的进程。
  local tail_pid=""
  cleanup() {
    # 先让脚本对信号免疫：清理期间再来一次 Ctrl-C 不该打断回收。
    # 这里**不能**写 `trap - INT TERM`（那等于恢复默认动作＝立刻终止自己）——
    # 实测（Windows + Git Bash）Ctrl-C 是控制台事件，同组进程可能收到不止一次，
    # 第二次就把正在清理的脚本当场杀掉，两个服务全成孤儿：
    # 现象是日志停在"进入清理函数"那一行，而端口仍 LISTENING。
    trap '' INT TERM
    # 清理路径必须关掉 errexit：任何一条清理命令返回非零都不该让"回收"半途而废。
    # 同理，回收只按启动时记下的 PID 直接杀，不在信号上下文里再 fork netstat/PowerShell。
    set +e
    printf '\n'
    info "收到停止信号。"
    if [ "$STARTED_STATIC" = "1" ]; then
      kill_recorded "$STATIC_OWNER_PID" "静态服务" "$STATIC_PORT"
    fi
    if [ "$STARTED_MCP" = "1" ]; then
      kill_recorded "$MCP_OWNER_PID" "MCP server" "$MCP_PORT"
    else
      info "MCP server 是复用的既有进程，保持运行。"
    fi
    if [ -n "$tail_pid" ]; then
      kill "$tail_pid" 2>/dev/null
    fi
    exit 0
  }
  trap cleanup INT TERM
  info "跟随日志（Ctrl-C 停止本次启动的进程）…"
  local files=()
  [ -f "$MCP_LOG" ] && files+=("$MCP_LOG")
  [ -f "$STATIC_LOG" ] && files+=("$STATIC_LOG")
  if [ "${#files[@]}" -gt 0 ]; then
    tail -n 20 -f "${files[@]}" &
    tail_pid=$!
    wait "$tail_pid" || true
  else
    info "没有日志文件可跟随。"
  fi
}

# kill_quiet=1 时不打印过程（清理路径用）
stop_one() {
  local port="$1" label="$2" quiet="${3:-0}"
  local pid cmd
  pid="$(port_owner "$port" || true)"
  if [ -z "$pid" ]; then
    [ "$quiet" = "1" ] || info "$label（端口 $port）未在运行。"
    return 0
  fi
  cmd="$(pid_cmdline "$pid" 2>/dev/null | tr -d '\n' || true)"
  if ! is_project_process "$cmd" && [ "$FORCE" != "1" ]; then
    warn "$label（端口 $port，pid $pid）看起来不是本项目的进程，未停止："
    warn "  $cmd"
    warn "  确认要停就加 --force。"
    return 1
  fi
  kill_pid "$pid"
  [ "$quiet" = "1" ] || info "已停止 $label（端口 $port，pid $pid）"
  sleep 0.5
  [ -n "$(port_owner "$port")" ] && warn "$label（端口 $port）仍被占用，可能需要手动处理。"
  return 0
}

cmd_stop() {
  local rc=0
  stop_one "$MCP_PORT" "MCP server" || rc=1
  # 静态服务端口也查一遍：上次 --daemon / --with-static 留下的进程不会记在参数里。
  stop_one "$STATIC_PORT" "静态服务" || rc=1
  rm -f "$OUT_DIR/mcp.pid" "$OUT_DIR/static.pid" 2>/dev/null || true
  return "$rc"
}

cmd_status() {
  printf '端口  服务         状态\n'
  local pid cmd health
  # 标签写死对齐宽度：printf 的 %-11s 按字节数算，中文标签（每字 2 列）会歪。
  for spec in "$MCP_PORT:MCP server  " "$STATIC_PORT:静态服务    "; do
    local port="${spec%%:*}" label="${spec#*:}"
    pid="$(port_owner "$port")"
    if [ -z "$pid" ]; then
      printf '%-5s %s 未运行\n' "$port" "$label"
      continue
    fi
    cmd="$(pid_cmdline "$pid" | tr -d '\n' | cut -c1-100)"
    printf '%-5s %s pid %s\n' "$port" "$label" "$pid"
    printf '      %s\n' "$cmd"
    if [ "$port" = "$MCP_PORT" ]; then
      health="$(wait_http "http://127.0.0.1:$port/health" 2 2>/dev/null || echo '无响应')"
      printf '      health: %s\n' "$health"
    fi
  done
}

cmd_logs() {
  local files=()
  [ -f "$MCP_LOG" ] && files+=("$MCP_LOG")
  [ -f "$STATIC_LOG" ] && files+=("$STATIC_LOG")
  [ "${#files[@]}" -gt 0 ] || die "还没有日志（先跑一次 up）"
  tail -n 40 -f "${files[@]}"
}

case "$CMD" in
  up) cmd_up ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) die "未知命令：$CMD" ;;
esac
