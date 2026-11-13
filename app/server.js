/* ------------------------------------------------------------------ */
/*  1Panel 面板一键安装器 · 桌面版  后端服务                            */
/*  Express + Socket.IO + SSH2                                          */
/*  仅监听 127.0.0.1，凭据不落盘、不上传第三方                            */
/* ------------------------------------------------------------------ */

const path = require('path');
const dns = require('dns').promises;
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('ssh2');
const { createLineFeeder } = require('./lib/linefeeder');

const PORT = Number(process.env.PORT) || 3942;
const HOST = '127.0.0.1';

/* ------------------------------------------------------------------ */
/*  1Panel 官方安装源                                                   */
/*  依据 https://github.com/1Panel-dev/1Panel 与官方 quick_start.sh     */
/*  v2 安装包内置的 install.sh 支持：                                    */
/*    --non-interactive --lang zh|en --install-dir --port --entrance    */
/*    --username --password --install-docker --docker-mode              */
/*    --configure-accelerator --replace-daemon-json                     */
/* ------------------------------------------------------------------ */

const EDITIONS = {
  cn: {
    key: 'cn',
    label: '中文版（国内源）',
    short: '中文版',
    lang: 'zh',
    base: 'https://resource.fit2cloud.com/1panel/package',
    note: '默认中文界面，应用商店使用国内源，应用数量更丰富',
  },
  intl: {
    key: 'intl',
    label: 'English（国际源）',
    short: '英文版',
    lang: 'en',
    base: 'https://resource.1panel.pro',
    note: '默认英文界面，使用 1Panel 国际源，适合海外服务器',
  },
};

/** uname -m → 1Panel 官方安装包架构名 */
const ARCH_MAP = {
  x86_64: 'amd64',
  amd64: 'amd64',
  aarch64: 'arm64',
  arm64: 'arm64',
  armv7l: 'armv7',
  ppc64le: 'ppc64le',
  s390x: 's390x',
  riscv64: 'riscv64',
};

const SUPPORTED_ARCH = ['amd64', 'arm64', 'armv7', 'ppc64le', 's390x', 'riscv64'];

/**
 * 系统支持矩阵：参照 1Panel 官方文档支持列表。
 * 1Panel 使用同一个通用安装包，按 CPU 架构选择包；系统类型用于兼容性判断与依赖提示。
 */
function judgeSystem(info) {
  const id = String(info.id || '').toLowerCase();
  const ver = parseInt(String(info.versionId || '').split('.')[0], 10) || 0;
  const archRaw = String(info.arch || 'x86_64').toLowerCase();
  const arch = ARCH_MAP[archRaw] || archRaw;
  const warnings = [];

  if (!SUPPORTED_ARCH.includes(arch)) {
    return {
      supported: false,
      canForce: false,
      family: id || 'unknown',
      arch,
      packageArch: null,
      reason: '当前 CPU 架构 ' + (info.arch || arch) + ' 不在 1Panel 官方安装包支持范围内（支持 amd64 / arm64 / armv7 / ppc64le / s390x / riscv64）',
      warnings,
    };
  }

  const ok = (family, reason) => ({ supported: true, canForce: true, family, arch, packageArch: arch, reason, warnings });
  const no = (family, reason) => ({ supported: false, canForce: false, family, arch, packageArch: arch, reason, warnings });

  if (/^(debian)$/.test(id)) {
    const dv = info.versionId || ver;
    if (ver >= 10) return ok('debian', 'Debian ' + dv + ' 受支持，将使用 ' + arch + ' 通用安装包');
    return no('debian', 'Debian ' + dv + ' 版本过低，1Panel 官方要求 Debian 10 及以上');
  }
  if (/^(ubuntu)$/.test(id)) {
    if (ver >= 18) {
      const uv = info.versionId || ver;
      if (ver % 2 !== 0) warnings.push('Ubuntu ' + uv + ' 不是 LTS 版本，生产环境建议使用 20.04 / 22.04 / 24.04 LTS');
      return ok('ubuntu', 'Ubuntu ' + uv + ' 受支持，将使用 ' + arch + ' 通用安装包');
    }
    return no('ubuntu', 'Ubuntu ' + (info.versionId || ver) + ' 版本过低，1Panel 官方要求 Ubuntu 18.04 及以上');
  }
  if (/^(centos)$/.test(id)) {
    if (ver >= 7) {
      const cv = info.versionId || ver;
      if (ver <= 7) warnings.push('CentOS 7 已停止维护，建议尽快迁移到 AlmaLinux / Rocky Linux / Ubuntu LTS');
      return ok('rhel', 'CentOS ' + cv + ' 受支持，将使用 ' + arch + ' 通用安装包');
    }
    return no('rhel', 'CentOS ' + (info.versionId || ver) + ' 版本过低，1Panel 官方要求 CentOS 7 及以上');
  }
  if (/^(rhel|redhat|almalinux|rocky|alibaba|alinux|fedora|openEuler|openeuler|anolis|opencloudos|tencentos)$/.test(id)) {
    if (/^(almalinux|rocky)$/.test(id) && ver > 0 && ver < 8) {
      return no('rhel', id + ' ' + ver + ' 版本过低，官方要求 8 及以上');
    }
    if (/^(rhel|redhat)$/.test(id) && ver > 0 && ver < 8) {
      return no('rhel', 'RHEL ' + ver + ' 版本过低，官方要求 8 及以上');
    }
    return ok('rhel', (info.pretty || id) + ' 受支持，将使用 ' + arch + ' 通用安装包');
  }
  if (/^(kylin|uos|uniontech|openkylin|deepin|neokylin)$/.test(id)) {
    return ok('domestic', (info.pretty || id) + ' 受支持（国产系统），将使用 ' + arch + ' 通用安装包');
  }

  // 未在官方列表内：不直接判死，允许用户确认后继续尝试
  return {
    supported: false,
    canForce: true,
    family: id || 'unknown',
    arch,
    packageArch: arch,
    reason: '未能识别的系统（' + (info.pretty || id || '未知') + '）。1Panel 官方推荐 Ubuntu / Debian / RHEL 系 / 国产系统，可确认兼容后继续尝试',
    warnings,
  };
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function randomToken(n, charset) {
  const chars = charset || 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function normalizeInstallDir(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '/opt';
  if (!s.startsWith('/')) return null;
  s = s.replace(/\/+$/, '');
  if (!s || s === '/') return null;
  if (/[\s'"]/.test(s)) return null;
  return s;
}

const RE_USER = /^[a-zA-Z0-9_]{3,30}$/;
const RE_ENTRANCE = /^[a-zA-Z0-9_]{3,30}$/;
const RE_PASS = /^[a-zA-Z0-9_!@#$%*,.?]{8,30}$/;

/** 归一化安装配置，并给出可读的校验错误 */
function normalizeConfig(raw) {
  const cfg = Object.assign({}, raw || {});
  const errors = [];
  const edition = EDITIONS[cfg.edition] ? cfg.edition : 'cn';
  const ed = EDITIONS[edition];

  let panelUser = String(cfg.panelUser == null ? '' : cfg.panelUser).trim();
  if (!panelUser) panelUser = 'admin';
  if (!RE_USER.test(panelUser)) errors.push('面板用户名需为 3–30 位字母、数字或下划线');

  let panelPass = String(cfg.panelPass == null ? '' : cfg.panelPass);
  if (!panelPass) panelPass = randomToken(14);
  if (!RE_PASS.test(panelPass)) errors.push('面板密码需为 8–30 位，仅允许字母、数字和 _ ! @ # $ % * , . ?');

  let entrance = String(cfg.entrance == null ? '' : cfg.entrance).trim().replace(/^\/+/, '');
  if (!entrance) entrance = randomToken(8).toLowerCase();
  if (!RE_ENTRANCE.test(entrance)) errors.push('安全入口需为 3–30 位字母、数字或下划线（不要带斜杠）');

  let panelPort = parseInt(cfg.panelPort, 10);
  if (!panelPort) panelPort = 20000 + Math.floor(Math.random() * 20000);
  if (!(panelPort >= 1 && panelPort <= 65535)) errors.push('面板端口需在 1–65535 之间');

  const installDir = normalizeInstallDir(cfg.installDir);
  if (!installDir) errors.push('安装目录必须是以 / 开头的绝对路径（默认 /opt）');

  const installDocker = cfg.installDocker === false || cfg.installDocker === 'n' ? 'n' : 'y';
  const dockerMode = ['auto', 'builtin', 'online'].includes(cfg.dockerMode) ? cfg.dockerMode : 'auto';
  let accelerator = 'n';
  if (edition === 'cn' && cfg.accelerator !== false && cfg.accelerator !== 'n') accelerator = 'y';
  if (cfg.accelerator === true || cfg.accelerator === 'y') accelerator = 'y';

  return {
    edition,
    editionLabel: ed.label,
    lang: ed.lang,
    base: ed.base,
    panelUser,
    panelPass,
    entrance,
    panelPort,
    installDir,
    installDocker,
    dockerMode,
    accelerator,
    errors,
  };
}

/** 构造自动安装命令：下载官方 v2 安装包 → 使用官方 install.sh 非交互安装 */
function buildInstallCommand(cfg) {
  const ed = EDITIONS[cfg.edition] || EDITIONS.cn;
  const args = [
    '--non-interactive',
    '--install-dir ' + shQuote(cfg.installDir),
    '--port ' + cfg.panelPort,
    '--entrance ' + shQuote(cfg.entrance),
    '--username ' + shQuote(cfg.panelUser),
    '--install-docker ' + cfg.installDocker,
    '--docker-mode ' + shQuote(cfg.dockerMode),
    '--configure-accelerator ' + cfg.accelerator,
    '--replace-daemon-json n',
  ];
  const envPrefix =
    'PANEL_NON_INTERACTIVE=1' +
    ' PANEL_LANG=' + shQuote(ed.lang) +
    ' PANEL_PASSWORD=' + shQuote(cfg.panelPass);

  const script = [
    'set -u',
    'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'WORK=/tmp/1panel-installer; rm -rf "$WORK"; mkdir -p "$WORK" && cd "$WORK" || exit 14',
    'ARCH_RAW=$(uname -m)',
    'case "$ARCH_RAW" in',
    '  x86_64|amd64) ARCH=amd64 ;;',
    '  aarch64|arm64) ARCH=arm64 ;;',
    '  armv7l) ARCH=armv7 ;;',
    '  ppc64le) ARCH=ppc64le ;;',
    '  s390x) ARCH=s390x ;;',
    '  riscv64) ARCH=riscv64 ;;',
    '  *) echo "===1P_UNSUPPORTED_ARCH==="; exit 20 ;;',
    'esac',
    'BASE=' + shQuote(ed.base),
    'VERSION=$(curl -fsSL --connect-timeout 20 --max-time 90 "$BASE/v2/stable/latest" | tr -d "\\r\\n")',
    'if [ -z "$VERSION" ]; then echo "===1P_VERSION_FAILED==="; exit 11; fi',
    'echo "1Panel 版本: $VERSION  架构: $ARCH  安装语言: ' + ed.lang + '"',
    'PKG="1panel-${VERSION}-linux-${ARCH}.tar.gz"',
    'URL="$BASE/v2/stable/${VERSION}/release/${PKG}"',
    'echo "安装包地址: $URL"',
    '(command -v curl >/dev/null 2>&1 && curl -fL --connect-timeout 20 --retry 2 -o "$PKG" "$URL") || wget -q --timeout=60 -O "$PKG" "$URL"',
    'if [ ! -s "$PKG" ]; then echo "===1P_DOWNLOAD_FAILED==="; exit 12; fi',
    'tar zxf "$PKG" || { echo "===1P_EXTRACT_FAILED==="; exit 13; }',
    'cd "1panel-${VERSION}-linux-${ARCH}" || exit 14',
    envPrefix + ' bash install.sh ' + args.join(' '),
    'CODE=$?',
    'echo "===1P_INSTALL_EXIT=${CODE}==="',
    'exit $CODE',
  ].join('\n');

  return {
    full: script,
    envPrefix,
    args,
    base: ed.base,
    lang: ed.lang,
    downloadUrlPattern: ed.base + '/v2/stable/${VERSION}/release/1panel-${VERSION}-linux-${ARCH}.tar.gz',
  };
}

/** 只生成给用户手动执行的命令（与自动安装同一套官方参数） */
function buildManualCommand(cfg) {
  return buildInstallCommand(cfg).full;
}

/** 把命令里的明文密码替换掉，用于日志显示 */
function maskCommand(command, password) {
  if (!password) return command;
  return String(command).split(password).join('**********');
}

/** 安装后读取 1Panel 面板信息 */
function buildInfoCommand() {
  return [
    'echo "===1P_INFO_BEGIN==="',
    'PCTL=/usr/local/bin/1pctl',
    'PORT=$(sed -n "s/^ORIGINAL_PORT=//p" "$PCTL" 2>/dev/null | head -1)',
    'ENTRANCE=$(sed -n "s/^ORIGINAL_ENTRANCE=//p" "$PCTL" 2>/dev/null | head -1)',
    'USERNAME=$(sed -n "s/^ORIGINAL_USERNAME=//p" "$PCTL" 2>/dev/null | head -1)',
    'BASE_DIR=$(sed -n "s/^BASE_DIR=//p" "$PCTL" 2>/dev/null | head -1)',
    'VERSION=$(/usr/local/bin/1panel version 2>/dev/null | grep -oE "v[0-9]+\\.[0-9]+\\.[0-9]+" | head -1)',
    'CORE=$(systemctl is-active 1panel-core 2>/dev/null || echo unknown)',
    'AGENT=$(systemctl is-active 1panel-agent 2>/dev/null || echo unknown)',
    'sleep 3',
    'HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "http://127.0.0.1:${PORT}/${ENTRANCE}" 2>/dev/null)',
    'HTTPS_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 8 "https://127.0.0.1:${PORT}/${ENTRANCE}" 2>/dev/null)',
    'echo "PORT=$PORT"',
    'echo "ENTRANCE=$ENTRANCE"',
    'echo "USERNAME=$USERNAME"',
    'echo "BASE_DIR=$BASE_DIR"',
    'echo "VERSION=$VERSION"',
    'echo "CORE=$CORE"',
    'echo "AGENT=$AGENT"',
    'echo "HTTP_CODE=$HTTP_CODE"',
    'echo "HTTPS_CODE=$HTTPS_CODE"',
    'echo "===1P_INFO_END==="',
  ].join('; ');
}

/* ------------------------------------------------------------------ */
/*  SSH 基础层                                                          */
/* ------------------------------------------------------------------ */

/**
 * 认证处理器：先探测服务器支持的认证方式，再依次尝试 password / keyboard-interactive
 * （部分服务器只把密码提供为 keyboard-interactive，直接试 password 会误报认证失败）
 */
function buildAuthHandler(cfg) {
  const password = cfg.privateKey ? '' : String(cfg.password == null ? '' : cfg.password);
  const detail = { offered: null, partial: false, tried: [], kiPrompts: 0 };
  let stage = 'probe';

  const handler = (authsLeft, partialSuccess, cb) => {
    if (Array.isArray(authsLeft) && authsLeft.length) detail.offered = authsLeft.slice();
    if (partialSuccess) detail.partial = true;

    const offers = (m) => !detail.offered || detail.offered.indexOf(m) !== -1;
    const triedIt = (m) => detail.tried.indexOf(m) !== -1;

    if (stage === 'probe') { stage = 'auth'; return 'none'; }

    if (cfg.privateKey && !triedIt('publickey') && offers('publickey')) {
      detail.tried.push('publickey');
      return 'publickey';
    }
    if (password) {
      if (!triedIt('password') && offers('password')) {
        detail.tried.push('password');
        return 'password';
      }
      if (!triedIt('keyboard-interactive') && offers('keyboard-interactive')) {
        detail.tried.push('keyboard-interactive');
        return {
          type: 'keyboard-interactive',
          username: cfg.sshUser || 'root',
          prompt: (name, instructions, lang, prompts, finish) => {
            const list = Array.isArray(prompts) ? prompts : [];
            detail.kiPrompts = list.length;
            finish(list.map((p, i) => (i === 0 ? password : '')));
          },
        };
      }
    }
    return false;
  };

  return { handler, detail };
}

function inspectCreds(cfg) {
  const user = String(cfg.sshUser == null ? '' : cfg.sshUser);
  if (!user.trim()) return { ok: false, msg: '请先填写 SSH 用户名（绝大多数服务器是 root）。' };

  if (cfg.privateKey) {
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(cfg.privateKey))) {
      return { ok: false, msg: '私钥内容不完整：需要包含 BEGIN / END 行的 OpenSSH 或 RSA 私钥；PuTTY 的 .ppk 需要先转换格式。' };
    }
    return { ok: true };
  }

  const pwd = String(cfg.password == null ? '' : cfg.password);
  if (!pwd) return { ok: false, msg: '没有收到 SSH 密码：请确认登录方式为密码登录并已填写密码。' };
  if (!pwd.trim()) return { ok: false, msg: 'SSH 密码里只有空格/换行：请重新输入。' };

  const hints = [];
  if (pwd !== pwd.trim()) hints.push('密码首尾有多余的空格或换行');
  if (/[\uFF01-\uFF5E\u3000]/.test(pwd)) hints.push('密码里含全角字符');
  return hints.length ? { ok: true, hint: hints.join('，') } : { ok: true };
}

function makeConnConfig(cfg) {
  const auth = buildAuthHandler(cfg);
  const c = {
    host: cfg.host,
    port: Number(cfg.sshPort) || 22,
    username: cfg.sshUser || 'root',
    readyTimeout: 20000,
    keepaliveInterval: 10000,
    tryKeyboard: true,
    authHandler: auth.handler,
    __authDetail: auth.detail,
  };
  if (cfg.privateKey) {
    c.privateKey = cfg.privateKey;
    if (cfg.passphrase) c.passphrase = cfg.passphrase;
  } else {
    c.password = cfg.password;
  }
  return c;
}

function friendlySSHError(e, detail) {
  const msg = (e && e.message) || String(e);
  const level = (e && e.level) || '';
  const d = detail || {};
  const offered = Array.isArray(d.offered) && d.offered.length ? d.offered : null;
  const tried = Array.isArray(d.tried) ? d.tried : [];

  const isAuthFailure = level === 'client-authentication'
    || /All configured authentication methods failed|Permission denied|Authentication failed|Too many authentication failures/i.test(msg);

  if (isAuthFailure) {
    if (/Too many authentication failures/i.test(msg)) {
      return '认证尝试次数过多：服务器限制了失败次数。请等待几分钟后重试，或改用密钥登录。';
    }
    if (d.partial) {
      return '服务器要求多因素认证：除密码外还需要其它验证方式，本工具暂不支持。请改用密钥登录。';
    }
    if (offered && offered.indexOf('publickey') === -1 && tried.indexOf('publickey') !== -1) {
      return '服务器不接受密钥登录（只允许：' + offered.join(' / ') + '）。请把认证方式切换为「密码」后重试。';
    }
    if (offered && offered.indexOf('password') === -1 && offered.indexOf('keyboard-interactive') === -1) {
      return '服务器不接受密码登录（只允许：' + offered.join(' / ') + '）。请把认证方式切换为「私钥」并填写私钥。';
    }
    let text = 'SSH 认证失败：请检查用户名/密码（或密钥）是否正确。部分服务商需先在控制台开启 root 密码登录。';
    if (offered) text += '（服务器允许的认证方式：' + offered.join(' / ') + '）';
    if (d.inputHint) text += '（检测到' + d.inputHint + '，请核对后重试）';
    return text;
  }

  if (/Cannot parse privateKey|Unsupported key format|bad passphrase|integrity check failed/i.test(msg)) {
    return '私钥无法读取：请确认粘贴的是完整私钥（含 BEGIN / END 行），有口令的私钥也要填写口令。';
  }
  if (/no matching (key exchange|host key algorithm|cipher|mac)|Key exchange failed|Unable to negotiate/i.test(msg)) {
    return '算法协商失败：服务器的 SSH 服务过旧或禁用了通用算法，无法握手。';
  }
  if (/ECONNRESET|EPIPE|Connection lost before handshake/i.test(msg)) {
    return '连接被中断：服务器在握手阶段主动断开了连接，常见于并发连接限制、防爆破策略或网络抖动。请稍后重试。';
  }
  if (/timed out|ETIMEDOUT/i.test(msg)) return '连接超时：请检查 IP 是否正确、SSH 端口是否对公网开放。';
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝：该端口未开放 SSH 服务，若改过 SSH 端口请填写正确端口。';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return '无法解析主机：请确认填写的是正确的服务器 IP。';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) return '网络不可达：请检查本机网络、服务器防火墙或云安全组。';
  return 'SSH 连接错误：' + msg;
}

/** 执行命令并逐行回调输出 */
function runCommand(conn, command, opts) {
  const raw = [];
  let buffer = '';
  const maxWait = opts.longRunning ? 45 * 60 * 1000 : 5 * 60 * 1000;
  const stallWarnMs = opts.stallWarnMs || 150 * 1000;
  const startedAt = Date.now();
  let finished = false;
  let lastData = Date.now();
  let stallNotified = false;

  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    try { if (feeder) feeder.flush(); } catch (_) {}
    opts.onExit && opts.onExit(code, raw.join(''));
  };

  const feeder = createLineFeeder(
    (line) => opts.onOutput && opts.onOutput(line),
    (text) => opts.onProgress && opts.onProgress(text)
  );

  const timer = setInterval(() => {
    const idle = Date.now() - lastData;
    const elapsed = Date.now() - startedAt;
    opts.onTick && opts.onTick({ elapsedMs: elapsed, idleMs: idle });
    if (!stallNotified && idle > stallWarnMs) {
      stallNotified = true;
      opts.onStall && opts.onStall({ idleMs: idle, elapsedMs: elapsed });
    }
    if (idle > maxWait) {
      try { stream.close(); } catch (_) {}
      finish(-1);
    }
  }, 5000);
  let stream = null;

  conn.exec(command, { pty: { mode: 'echo' }, env: { TERM: 'xterm' } }, (err, s) => {
    if (err) { clearInterval(timer); finish(-1); return; }
    stream = s;
    s.on('close', (code) => finish(code))
      .on('data', (data) => {
        lastData = Date.now();
        const text = data.toString('utf8');
        raw.push(text);
        feeder.feed(text);
      });
    s.stderr.on('data', (data) => {
      lastData = Date.now();
      const text = data.toString('utf8');
      raw.push(text);
      feeder.feed(text);
    });
    if (opts.feedStdin) {
      try { s.write(opts.feedStdin); } catch (_) {}
    }
  });
}

/** 执行一条命令并收集完整输出（带超时，避免远端等待输入时永久挂起） */
function execCapture(conn, command, cb, timeoutMs) {
  let raw = '';
  let finished = false;
  let timer = null;
  const finish = (err) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    cb(err, raw);
  };
  conn.exec(command, (err, stream) => {
    if (err) { finish(err); return; }
    timer = setTimeout(() => {
      try { stream.close(); } catch (_) {}
      finish(null);
    }, timeoutMs || 120000);
    stream.on('close', () => finish(null))
      .on('data', (d) => { raw += d.toString('utf8'); })
      .stderr.on('data', (d) => { raw += d.toString('utf8'); });
  });
}

/** 执行命令并喂入 stdin（用于 1pctl 的交互式确认），超时即收口 */
function execCaptureInput(conn, command, input, timeoutMs, cb) {
  let raw = '';
  let finished = false;
  let timer = null;
  const finish = (err) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    cb(err, raw);
  };
  conn.exec(command, (err, stream) => {
    if (err) { finish(err); return; }
    timer = setTimeout(() => {
      try { stream.close(); } catch (_) {}
      finish(null);
    }, timeoutMs || 45000);
    stream.on('close', () => finish(null))
      .on('data', (d) => { raw += d.toString('utf8'); })
      .stderr.on('data', (d) => { raw += d.toString('utf8'); });
    if (input) { try { stream.write(input); } catch (_) {} }
  });
}

/* ------------------------------------------------------------------ */
/*  Socket 流程                                                         */
/* ------------------------------------------------------------------ */

const activeConn = new Map();

function createApp() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  io.on('connection', (socket) => {
    socket.on('disconnect', () => {
      const conn = activeConn.get(socket.id);
      if (conn) { try { conn.end(); } catch (_) {} activeConn.delete(socket.id); }
    });

    /** 测试 SSH 连通性 */
    socket.on('ssh:test', (cfg, ack) => {
      const conn = new Client();
      const connCfg = makeConnConfig(cfg);
      let settled = false;
      const done = (ok, msg, extra) => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch (_) {}
        if (typeof ack === 'function') ack(Object.assign({ ok, msg }, extra || {}));
      };

      const pre = inspectCreds(cfg);
      if (!pre.ok) { done(false, pre.msg); return; }
      if (pre.hint) connCfg.__authDetail.inputHint = pre.hint;

      conn.on('ready', () => done(true, '连接成功'))
        .on('error', (e) => done(false, friendlySSHError(e, connCfg.__authDetail)))
        .on('close', () => { if (!settled) done(false, '连接被中断：服务器在握手或认证阶段主动断开了连接。请稍后重试。'); })
        .on('timeout', () => { if (!settled) done(false, '连接超时：服务器在 20 秒内没有响应握手。'); });

      try { conn.connect(connCfg); } catch (e) { done(false, friendlySSHError(e, connCfg.__authDetail)); }
    });

    /** 探测系统类型、版本与架构，给出 1Panel 兼容性与包架构 */
    socket.on('system:detect', (cfg, ack) => {
      const conn = new Client();
      let settled = false;
      const done = (payload) => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch (_) {}
        if (typeof ack === 'function') ack(payload);
      };

      const cmd = [
        'echo "ID=$(. /etc/os-release 2>/dev/null && echo $ID)"',
        'echo "VERSION_ID=$(. /etc/os-release 2>/dev/null && echo $VERSION_ID)"',
        'echo "PRETTY=$(. /etc/os-release 2>/dev/null && echo \\"$PRETTY_NAME\\")"',
        'echo "ARCH=$(uname -m)"',
        'echo "BIT=$(getconf LONG_BIT)"',
        'echo "KERNEL=$(uname -r)"',
        'echo "MEM=$(free -m | awk \'/Mem:/{print $2}\')"',
        'echo "DISK=$(df -m / | awk \'NR==2{print $4}\')"',
        'echo "ROOT=$( [ "$(id -u)" = "0" ] && echo yes || echo no )"',
        'echo "HOSTNAME=$(cat /etc/hostname 2>/dev/null)"',
        'echo "PANEL_INSTALLED=$( (command -v 1pctl >/dev/null 2>&1 || [ -x /opt/1panel/1pctl ]) && echo yes || echo no )"',
        'echo "PANEL_VERSION=$(/usr/local/bin/1panel version 2>/dev/null | grep -oE \\"v[0-9]+\\.[0-9]+\\.[0-9]+\\" | head -1)"',
        'echo "DOCKER=$(command -v docker >/dev/null 2>&1 && docker --version 2>/dev/null | head -1)"',
      ].join('; ');

      conn.on('ready', () => {
        execCapture(conn, cmd, (err, raw) => {
          if (err) { done({ ok: false, msg: '读取系统信息失败：' + err.message }); return; }
          const get = (k) => {
            const m = raw.match(new RegExp('^' + k + '=(.*)$', 'm'));
            return m ? m[1].trim().replace(/^"|"$/g, '') : '';
          };
          const info = {
            ok: true,
            id: get('ID'),
            versionId: get('VERSION_ID'),
            pretty: get('PRETTY'),
            arch: get('ARCH'),
            bit: get('BIT'),
            kernel: get('KERNEL'),
            memMb: parseInt(get('MEM'), 10) || 0,
            diskFreeMb: parseInt(get('DISK'), 10) || 0,
            isRoot: get('ROOT') === 'yes',
            hostname: get('HOSTNAME'),
            panelInstalled: get('PANEL_INSTALLED') === 'yes',
            panelVersion: get('PANEL_VERSION'),
            docker: get('DOCKER'),
          };
          info.judgement = judgeSystem(info);
          if (info.memMb && info.memMb < 1024) {
            info.judgement.warnings.push('内存仅 ' + info.memMb + ' MB，1Panel 官方最低要求 1 GB，建议 2 GB 以上');
          } else if (info.memMb && info.memMb < 2048) {
            info.judgement.warnings.push('内存 ' + info.memMb + ' MB 可安装，运行应用商店中的服务时建议 2 GB 以上');
          }
          if (info.diskFreeMb && info.diskFreeMb < 10240) {
            info.judgement.warnings.push('根分区可用空间仅 ' + Math.round(info.diskFreeMb / 1024) + ' GB，1Panel 与镜像建议预留 20 GB 以上');
          }
          info.raw = raw;
          done(info);
        });
      })
        .on('error', (e) => done({ ok: false, msg: friendlySSHError(e) }))
        .on('close', () => { if (!settled) done({ ok: false, msg: '连接在探测系统时被中断，请重试。' }); });

      try { conn.connect(makeConnConfig(cfg)); } catch (e) { done({ ok: false, msg: friendlySSHError(e) }); }
    });

    /** 开始安装 */
    socket.on('install:start', (cfg) => {
      const emit = (event, data) => socket.emit(event, data);
      const pre = inspectCreds(cfg);
      if (!pre.ok) { emit('install:failed', { error: pre.msg }); return; }

      const eff = normalizeConfig(cfg);
      if (eff.errors.length) { emit('install:failed', { error: eff.errors.join('；') }); return; }
      emit('install:config', {
        edition: eff.edition,
        editionLabel: eff.editionLabel,
        panelUser: eff.panelUser,
        panelPass: eff.panelPass,
        panelPort: eff.panelPort,
        entrance: eff.entrance,
        installDir: eff.installDir,
      });

      const conn = new Client();
      activeConn.set(socket.id, conn);

      conn.on('ready', () => {
        emit('log', { level: 'success', text: '✓ SSH 连接成功' });
        emit('stage', { stage: 1, text: '正在识别服务器系统类型与版本' });

        const probe = [
          'echo "ID=$(. /etc/os-release 2>/dev/null && echo $ID)"',
          'echo "VERSION_ID=$(. /etc/os-release 2>/dev/null && echo $VERSION_ID)"',
          'echo "PRETTY=$(. /etc/os-release 2>/dev/null && echo \\"$PRETTY_NAME\\")"',
          'echo "ARCH=$(uname -m)"',
          'echo "ROOT=$( [ "$(id -u)" = "0" ] && echo yes || echo no )"',
          'echo "PANEL_INSTALLED=$( (command -v 1pctl >/dev/null 2>&1 || [ -x /opt/1panel/1pctl ]) && echo yes || echo no )"',
          'echo "PORT_USED=$( (ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | grep -q ":' + eff.panelPort + ' " && echo yes || echo no )"',
        ].join('; ');

        execCapture(conn, probe, (err, raw) => {
          if (err) { emit('install:failed', { error: '读取系统信息失败：' + err.message }); return; }
          const get = (k) => {
            const m = raw.match(new RegExp('^' + k + '=(.*)$', 'm'));
            return m ? m[1].trim().replace(/^"|"$/g, '') : '';
          };
          const info = { id: get('ID'), versionId: get('VERSION_ID'), pretty: get('PRETTY'), arch: get('ARCH'), isRoot: get('ROOT') === 'yes' };
          const judge = judgeSystem(info);
          if (!judge.supported && cfg.force) {
            judge.supported = true;
            judge.warnings.push('系统未在官方支持列表内，已按你的确认继续安装');
          }

          emit('system', { info, judgement: judge });
          emit('log', { level: 'info', text: '系统：' + (info.pretty || info.id || '未知') + '（' + (info.arch || '?') + '）→ ' + judge.reason });

          if (!judge.supported) {
            emit('install:failed', { error: '系统不受支持：' + judge.reason, canForce: !!judge.canForce });
            try { conn.end(); } catch (_) {}
            activeConn.delete(socket.id);
            return;
          }
          if (!info.isRoot) {
            emit('install:failed', { error: '当前 SSH 用户不是 root。1Panel 官方安装脚本必须以 root 身份执行，请改用 root 登录（或先配置 sudo 免密）。' });
            try { conn.end(); } catch (_) {}
            activeConn.delete(socket.id);
            return;
          }
          if (get('PANEL_INSTALLED') === 'yes') {
            emit('install:failed', { error: '该服务器已安装 1Panel。官方安装脚本会拒绝重复安装，请直接使用现有面板，或先在服务器执行 1pctl uninstall 卸载后再装。' });
            try { conn.end(); } catch (_) {}
            activeConn.delete(socket.id);
            return;
          }
          if (get('PORT_USED') === 'yes') {
            emit('install:failed', { error: '面板端口 ' + eff.panelPort + ' 已被服务器上的其它程序占用，请换一个端口后重试。' });
            try { conn.end(); } catch (_) {}
            activeConn.delete(socket.id);
            return;
          }

          const cmd = buildInstallCommand(eff);
          emit('stage', { stage: 2, text: '正在下载并执行 1Panel 官方安装包（约 3–8 分钟，请勿关闭窗口）' });
          emit('cmd', { text: maskCommand(cmd.full, eff.panelPass) });
          emit('log', { level: 'info', text: '安装源：' + cmd.base + ' · 语言：' + cmd.lang + ' · 包架构：' + judge.packageArch });

          runCommand(conn, cmd.full, {
            longRunning: true,
            onTick: (t) => emit('tick', t),
            onStall: (t) => emit('install:stall', {
              idleSec: Math.round(t.idleMs / 1000),
              elapsedSec: Math.round(t.elapsedMs / 1000),
            }),
            onProgress: (line) => emit('progress', line),
            onOutput: (line) => {
              if (line.trim()) emit('term', line + '\n');
            },
            onExit: (code, out) => {
              if (/===1P_UNSUPPORTED_ARCH===/.test(out)) {
                emit('install:failed', { error: '服务器 CPU 架构不在 1Panel 官方安装包支持范围内。' });
                activeConn.delete(socket.id);
                return;
              }
              if (/===1P_VERSION_FAILED===/.test(out)) {
                emit('install:failed', { error: '无法获取 1Panel 最新版本号：服务器访问官方源失败，请检查服务器网络后重试。' });
                activeConn.delete(socket.id);
                return;
              }
              if (/===1P_DOWNLOAD_FAILED===/.test(out)) {
                emit('install:failed', { error: '1Panel 安装包下载失败：服务器无法访问官方安装源。中文源失败可切换英文（国际）源重试。' });
                activeConn.delete(socket.id);
                return;
              }
              if (/===1P_EXTRACT_FAILED===/.test(out)) {
                emit('install:failed', { error: '安装包解压失败：下载文件可能不完整，请重试。' });
                activeConn.delete(socket.id);
                return;
              }

              emit('stage', { stage: 3, text: '安装脚本已结束，正在核对面板信息' });
              execCapture(conn, buildInfoCommand(), (err2, raw2) => {
                const parsed = parsePanelInfo(raw2 || '');
if (code !== 0) {
                  emit('install:failed', {
                    error: '1Panel 安装未完成（脚本退出码 ' + code + '）。请查看上方日志定位失败步骤。常见原因：① Docker 安装失败 ② 端口/安全入口不合规 ③ 磁盘或内存不足 ④ 服务器无法访问安装源。',
                  });
                  try { conn.end(); } catch (_) {}
                  activeConn.delete(socket.id);
                  return;
                }
                if (parsed.core && ['failed', 'inactive'].includes(parsed.core)) {
                  emit('install:failed', { error: '1Panel Core 服务未正常启动（状态：' + parsed.core + '）。请在「面板急救箱」查看服务状态与日志。' });
                  try { conn.end(); } catch (_) {}
                  activeConn.delete(socket.id);
                  return;
                }

                const port = parsed.port || String(eff.panelPort);
                const entrance = (parsed.entrance || eff.entrance).replace(/^\/+/, '');
                const scheme = parsed.httpsCode && parsed.httpsCode !== '000' && parsed.httpsCode !== '' ? 'https' : 'http';
                const panelUrl = scheme + '://' + cfg.host + ':' + port + (entrance ? '/' + entrance : '');

                try { conn.end(); } catch (_) {}
                activeConn.delete(socket.id);

                emit('install:done', {
                  url: panelUrl,
                  scheme,
                  port,
                  entrance: '/' + entrance,
                  username: parsed.username || eff.panelUser,
                  password: eff.panelPass,
                  version: parsed.version || '',
                  baseDir: String(parsed.baseDir || eff.installDir).replace(/\/+$/, '') + '/1panel',
                  core: parsed.core || '',
                  agent: parsed.agent || '',
                  localHttp: parsed.httpCode || '',
                  httpsAvailable: scheme === 'https',
                  edition: eff.editionLabel,
                  dockerInstalled: eff.installDocker === 'y',
                  note: parsed.httpCode && parsed.httpCode !== '000' && !['200', '302', '401'].includes(parsed.httpCode)
                    ? '本地访问面板返回 HTTP ' + parsed.httpCode + '，请稍后在浏览器确认；若仍打不开，检查云安全组是否放行端口。'
                    : '',
                });
              });
            },
          });
        });
      })
        .on('error', (e) => emit('install:failed', { error: friendlySSHError(e) }))
        .on('close', () => { activeConn.delete(socket.id); });

      try { conn.connect(makeConnConfig(cfg)); } catch (e) { emit('install:failed', { error: friendlySSHError(e) }); }
    });

    socket.on('install:abort', () => {
      const conn = activeConn.get(socket.id);
      if (conn) {
        try { conn.end(); } catch (_) {}
        activeConn.delete(socket.id);
      }
      socket.emit('install:failed', { error: '已手动中止安装。' });
    });

    /** 从 1Panel 信息块解析面板数据 */
    function parsePanelInfo(raw) {
      const clean = String(raw || '').replace(/\x1b\[[0-9;]*m/g, '');
      const get = (k) => {
        const m = clean.match(new RegExp('^' + k + '=(.*)$', 'm'));
        return m ? m[1].trim() : '';
      };
      return {
        port: get('PORT'),
        entrance: get('ENTRANCE'),
        username: get('USERNAME'),
        baseDir: get('BASE_DIR'),
        version: get('VERSION'),
        core: get('CORE'),
        agent: get('AGENT'),
        httpCode: get('HTTP_CODE'),
        httpsCode: get('HTTPS_CODE'),
      };
    }

    /** 面板急救箱：查看信息 / 端口防火墙 / 重启 / 重置密码 / 重置安全入口 */
    socket.on('rescue:run', (data, ack) => {
      const { server: srv, action, newPassword } = data || {};
      if (!srv || !srv.host) { ack && ack({ ok: false, output: '请先填写服务器信息' }); return; }
      if (!srv.password && !srv.privateKey) { ack && ack({ ok: false, output: '请填写 SSH 密码或私钥' }); return; }

      const conn = new Client();
      let script = '';
      let feed = '';

      if (action === 'info') {
        script = [
          'PCTL=/usr/local/bin/1pctl',
          'if [ ! -x "$PCTL" ]; then echo "未检测到 1Panel：/usr/local/bin/1pctl 不存在"; exit 1; fi',
          'echo "===== 面板登录信息 ====="',
          '"$PCTL" user-info 2>&1',
          'echo "===== 版本 ====="',
          '"$PCTL" version 2>&1',
          'echo "===== 服务状态 ====="',
          '"$PCTL" status 2>&1',
        ].join('; ');
      } else if (action === 'portinfo') {
        script = [
          'PCTL=/usr/local/bin/1pctl',
          'PORT=$(sed -n "s/^ORIGINAL_PORT=//p" "$PCTL" 2>/dev/null | head -1)',
          'ENTRANCE=$(sed -n "s/^ORIGINAL_ENTRANCE=//p" "$PCTL" 2>/dev/null | head -1)',
          'echo "端口：${PORT:-未读取到}  安全入口：${ENTRANCE:-未读取到}"',
          'echo "===== 监听状态 ====="',
          '(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -E "1panel|:${PORT}" | head -10',
          'echo "===== 本机访问 ====="',
          'curl -s -o /dev/null -w "HTTP %{http_code}\\n" --max-time 6 "http://127.0.0.1:${PORT}/${ENTRANCE}" 2>/dev/null',
          'curl -sk -o /dev/null -w "HTTPS %{http_code}\\n" --max-time 6 "https://127.0.0.1:${PORT}/${ENTRANCE}" 2>/dev/null',
          'echo "===== 防火墙 ====="',
          '(ufw status 2>/dev/null || firewall-cmd --list-ports 2>/dev/null || iptables -S 2>/dev/null | head -20)',
        ].join('; ');
      } else if (action === 'restart') {
        script = [
          'PCTL=/usr/local/bin/1pctl',
          '[ -x "$PCTL" ] || { echo "未检测到 1Panel"; exit 1; }',
          '"$PCTL" restart 2>&1',
          'echo "===== 当前状态 ====="',
          '"$PCTL" status 2>&1',
        ].join('; ');
      } else if (action === 'resetpwd') {
        const pwd = String(newPassword || '');
        if (!RE_PASS.test(pwd)) {
          ack && ack({ ok: false, output: '新密码需为 8–30 位，仅允许字母、数字和 _ ! @ # $ % * , . ?' });
          return;
        }
        script = [
          'PCTL=/usr/local/bin/1pctl',
          '[ -x "$PCTL" ] || { echo "未检测到 1Panel"; exit 1; }',
          '"$PCTL" update password ' + shQuote(pwd) + ' 2>&1',
          'echo "===== 当前登录信息 ====="',
          '"$PCTL" user-info 2>&1',
        ].join('; ');
        feed = pwd + '\n' + pwd + '\n';
      } else if (action === 'resetentrance') {
        script = [
          'PCTL=/usr/local/bin/1pctl',
          '[ -x "$PCTL" ] || { echo "未检测到 1Panel"; exit 1; }',
          '"$PCTL" reset entrance 2>&1',
          'echo "===== 当前登录信息 ====="',
          '"$PCTL" user-info 2>&1',
        ].join('; ');
        feed = 'y\nyes\n';
      } else {
        ack && ack({ ok: false, output: '未知操作' });
        return;
      }

conn.on('ready', () => {
        execCaptureInput(conn, script, feed, 60000, (err, raw) => {
          try { conn.end(); } catch (_) {}
          const out = err ? (err.message || String(err)) : raw;
          ack && ack({
            ok: !err && !/Traceback|command not found|No such file/i.test(out),
            output: out || '(无输出)',
          });
        });
      })
        .on('error', (e) => ack && ack({ ok: false, output: friendlySSHError(e) }));

      try { conn.connect(makeConnConfig(srv)); } catch (e) { ack && ack({ ok: false, output: friendlySSHError(e) }); }
    });

    /** 域名解析检查 */
    socket.on('domain:check', (data, ack) => {
      const { domain, expectedIp } = data || {};
      if (!domain) { ack && ack({ ok: false, msg: '请填写域名' }); return; }
      const name = String(domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
      const servers = ['1.1.1.1', '8.8.8.8'];
      Promise.allSettled(servers.map((s) => dns.resolve4(name, { server: s })))
        .then((results) => {
          const ips = [...new Set(results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value))];
          if (!ips.length) { ack && ack({ ok: false, msg: '域名解析失败：未查询到 A 记录，请先在 DNS 服务商添加指向服务器 IP 的记录' }); return; }
          const hit = expectedIp ? ips.includes(expectedIp) : false;
          ack && ack({
            ok: true,
            ips,
            matched: hit,
            msg: hit
              ? '域名已解析到本服务器（' + ips.join(', ') + '）'
              : '域名解析到 ' + ips.join(', ') + '，与服务器 IP 不一致；若使用 Cloudflare 代理属正常，否则请检查 DNS',
          });
        })
        .catch((e) => ack && ack({ ok: false, msg: '解析异常：' + e.message }));
    });

    /** 面板 HTTPS / 访问状态 */
    socket.on('ssl:status', (data, ack) => {
      const { server: srv, domain } = data || {};
      if (!srv || !srv.host) { ack && ack({ ok: false, output: '请先填写服务器信息' }); return; }
      const conn = new Client();
      conn.on('ready', () => {
        const script = [
          'PCTL=/usr/local/bin/1pctl',
          '[ -x "$PCTL" ] || { echo "未检测到 1Panel（/usr/local/bin/1pctl 不存在）"; exit 0; }',
          'PORT=$(sed -n "s/^ORIGINAL_PORT=//p" "$PCTL" 2>/dev/null | head -1)',
          'ENTRANCE=$(sed -n "s/^ORIGINAL_ENTRANCE=//p" "$PCTL" 2>/dev/null | head -1)',
          'echo "===== 面板信息 ====="',
          '"$PCTL" user-info 2>&1',
          'echo "===== 访问协议 ====="',
          'echo "HTTP  $(curl -s -o /dev/null -w "%{http_code}" --max-time 6 "http://127.0.0.1:${PORT}/${ENTRANCE}" 2>/dev/null)"',
          'echo "HTTPS $(curl -sk -o /dev/null -w "%{http_code}" --max-time 6 "https://127.0.0.1:${PORT}/${ENTRANCE}" 2>/dev/null)"',
          'echo "===== 证书（HTTPS 启用时可见） ====="',
          'timeout 8 openssl s_client -connect "127.0.0.1:${PORT}" -servername "' + String(domain || srv.host || '') + '" </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null || echo "未读取到证书（面板可能未启用 HTTPS）"',
          'echo "===== 防火墙中的面板端口 ====="',
          'PORT_RE=$(echo "$PORT" | sed "s/[^0-9]//g")',
          '(ufw status 2>/dev/null | grep -E "$PORT_RE|Status"; firewall-cmd --list-ports 2>/dev/null | tr " " "\\n" | grep "$PORT_RE") 2>/dev/null || true',
        ].join('; ');
        execCapture(conn, script, (err, raw) => {
          try { conn.end(); } catch (_) {}
          ack && ack({ ok: !err, output: err ? err.message : raw });
        });
      })
        .on('error', (e) => ack && ack({ ok: false, output: friendlySSHError(e) }));
      try { conn.connect(makeConnConfig(srv)); } catch (e) { ack && ack({ ok: false, output: friendlySSHError(e) }); }
    });

    /** 生成手动安装命令 */
    socket.on('cmd:generate', (cfg, ack) => {
      try {
        const eff = normalizeConfig(cfg);
        if (eff.errors.length) { ack && ack({ ok: false, msg: eff.errors.join('；') }); return; }
        ack && ack({
          ok: true,
          command: buildManualCommand(eff),
          config: {
            panelUser: eff.panelUser,
            panelPass: eff.panelPass,
            panelPort: eff.panelPort,
            entrance: eff.entrance,
            edition: eff.editionLabel,
          },
          note: '以 root 身份在服务器上执行；命令含明文面板密码（位于 PANEL_PASSWORD 环境变量），请勿分享。',
        });
      } catch (e) {
        ack && ack({ ok: false, msg: e.message });
      }
    });

    /** 直接执行一条命令（面板急救箱的高级用法） */
    socket.on('cmd:run', (data, ack) => {
      const { server: srv, command } = data || {};
      if (!srv || !command || !String(command).trim()) { ack && ack({ ok: false, output: '请填写服务器信息和要执行的命令' }); return; }
      const conn = new Client();
      conn.on('ready', () => {
        execCapture(conn, String(command).trim(), (err, raw) => {
          try { conn.end(); } catch (_) {}
          ack && ack({ ok: !err, output: err ? (err.message || String(err)) : raw });
        });
      })
        .on('error', (e) => ack && ack({ ok: false, output: friendlySSHError(e) }));
      try { conn.connect(makeConnConfig(srv)); } catch (e) { ack && ack({ ok: false, output: friendlySSHError(e) }); }
    });

    /** 元数据 */
    socket.on('meta:get', (_, ack) => {
      ack && ack({
        ok: true,
        editions: Object.keys(EDITIONS).map((k) => ({
          key: k,
          label: EDITIONS[k].label,
          note: EDITIONS[k].note,
        })),
        defaults: {
          panelUser: 'admin',
          panelPort: '',
          entrance: '',
          panelPass: '',
          installDir: '/opt',
        },
      });
    });

    /** 生成随机凭据（符合 1Panel install.sh 校验规则） */
    socket.on('creds:random', (_, ack) => {
      ack && ack({
        ok: true,
        username: 'admin',
        password: randomToken(14),
        entrance: randomToken(8).toLowerCase(),
        port: String(20000 + Math.floor(Math.random() * 20000)),
        installDir: '/opt',
      });
    });
  });

  return { app, server, io };
}

/* ------------------------------------------------------------------ */
/*  兜底与启动                                                          */
/* ------------------------------------------------------------------ */

function start() {
  const { server } = createApp();
  process.on('uncaughtException', (e) => console.error('[guard] 未捕获异常：', (e && e.stack) || e));
  process.on('unhandledRejection', (r) => console.error('[guard] 未处理的 Promise 拒绝：', (r && r.stack) || r));

  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('[启动失败] 端口 ' + PORT + ' 已被占用，请关闭占用该端口的程序后重新启动。');
    } else {
      console.error('[启动失败] ' + ((e && e.message) || e));
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log('  1Panel 面板一键安装器 · 桌面版');
    console.log('  本地地址 →  http://' + HOST + ':' + PORT);
  });
  return server;
}

if (require.main === module) start();

module.exports = {
  EDITIONS,
  SUPPORTED_ARCH,
  judgeSystem,
  normalizeConfig,
  buildInstallCommand,
  buildManualCommand,
  maskCommand,
  createApp,
  start,
};