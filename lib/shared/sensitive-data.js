// 敏感数据识别与脱敏。
//
// 这一层必须同时能被内容脚本与 Service Worker 使用，所以保持纯函数、零浏览器依赖。
// 目标不是“尽量聪明”，而是给所有模型可见出口一条统一、可测试的最低安全线：
//   · 凭据 / 金融信息永不原样传给模型；
//   · URL 中的 token/session 参数隐藏值；
//   · 表单字段根据 type/autocomplete/name/label 判断是否敏感。
//
// 模式识别只能兜底，不能替代动作层的硬拦截：密码输入框首先应在执行前被拒绝。

const SECRET_KEY_RE =
  /^(?:password|passwd|pwd|passcode|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|cookie|set[_-]?cookie|session|sessionid|card[_-]?number|pan|cvv|cvc|security[_-]?code|otp|one[_-]?time[_-]?code)$/i;

const SENSITIVE_URL_PARAM_RE =
  /(^|[?&#])((?:password|passwd|pwd|token|access_token|refresh_token|id_token|api_key|apikey|secret|session|sessionid|code|authorization|signature|sig))=([^&#\s]*)/gi;

const SENSITIVE_FIELD_TEXT_RE =
  /(密码|口令|验证码|动态码|安全码|银行卡|卡号|身份证|护照|私钥|密钥|令牌|授权码|password|passwd|passcode|one[-\s]?time|otp|mfa|2fa|cvv|cvc|security code|card number|credit card|debit card|api key|access token|private key|secret)/i;

const SENSITIVE_AUTOCOMPLETE_RE =
  /(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name)/i;

function normalizedKey(key) {
  return String(key || '').replace(/[\s-]+/g, '_');
}

function isLikelyCardNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits.charAt(i));
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function maskDigits(raw) {
  const s = String(raw || '');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 4) return '[已隐藏:卡号]';
  return '**** **** **** ' + digits.slice(-4);
}

/**
 * 字段是否属于凭据 / 金融敏感输入。
 * 返回的 category 用于动作拦截和隐藏说明，不包含字段的真实值。
 */
export function classifySensitiveField(field) {
  const f = field && typeof field === 'object' ? field : {};
  const inputType = String(f.inputType || f.type || '').toLowerCase();
  const autocomplete = String(f.autocomplete || '').toLowerCase();
  const descriptor = [
    f.name,
    f.id,
    f.testid,
    f.placeholder,
    f.label,
    f.ariaLabel,
    f.title,
  ]
    .filter(Boolean)
    .join(' ');

  if (inputType === 'password') {
    return { sensitive: true, category: 'credentials', label: String(f.label || f.name || '密码输入框') };
  }
  if (SENSITIVE_AUTOCOMPLETE_RE.test(autocomplete)) {
    const category = /^cc-/.test(autocomplete) ? 'payment-card' : 'credentials';
    return { sensitive: true, category, label: String(f.label || f.name || autocomplete) };
  }
  if (SENSITIVE_FIELD_TEXT_RE.test(descriptor)) {
    const category =
      /(银行卡|卡号|cvv|cvc|security code|card number|credit card|debit card)/i.test(descriptor)
        ? 'payment-card'
        : /(密码|口令|验证码|动态码|otp|mfa|2fa|password|passwd|passcode|one[-\s]?time)/i.test(descriptor)
          ? 'credentials'
          : 'secret';
    return { sensitive: true, category, label: String(f.label || f.name || f.placeholder || '敏感输入框') };
  }
  return { sensitive: false, category: '', label: '' };
}

/** 输入值本身是否明显是密钥/令牌/卡号。用于宏轨迹等无法拿到字段语义的兜底。 */
export function containsLikelySecret(value) {
  const text = String(value == null ? '' : value);
  if (!text) return false;
  if (/(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/.test(text)) return true;
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) return true;
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text)) return true;
  if (/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i.test(text)) return true;
  if (isLikelyCardNumber(text)) return true;
  return false;
}

/** 隐藏 URL 查询串/片段里的 token、session、code 等敏感参数。 */
export function redactUrl(rawUrl) {
  const text = String(rawUrl || '');
  if (!text) return '';
  return text.replace(SENSITIVE_URL_PARAM_RE, (whole, prefix, key) => prefix + key + '=[已隐藏]');
}

/**
 * 文本脱敏。只替换高置信度秘密，不做大范围个人信息伪装，避免破坏正常阅读任务。
 * `options.maskPersonal=true` 时额外掩码邮箱、手机号和身份证号。
 */
export function redactSensitiveText(value, options = {}) {
  let text = String(value == null ? '' : value);
  if (!text) return '';

  text = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    '[已隐藏:私钥]'
  );
  text = text.replace(SENSITIVE_URL_PARAM_RE, (whole, prefix, key) => prefix + key + '=[已隐藏]');
  text = text.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏:API Key]');
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[已隐藏:令牌]');
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[已隐藏:访问密钥]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[已隐藏:JWT]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [已隐藏:令牌]');
  text = text.replace(
    /((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)([^\r\n]{1,500})/gi,
    (whole, lead) => lead + '[已隐藏]'
  );
  text = text.replace(
    /((?:password|passwd|pwd|passcode|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|session(?:id)?|cvv|cvc|security code|otp|one[-\s]?time code|密码|口令|验证码|动态码|安全码)\s*[:=：]\s*)([^\s,;，；]{1,240})/gi,
    (whole, lead) => lead + '[已隐藏]'
  );
  text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => (isLikelyCardNumber(m) ? maskDigits(m) : m));

  if (options.maskPersonal === true) {
    text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[已隐藏:邮箱]');
    text = text.replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[已隐藏:手机号]');
    text = text.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[已隐藏:证件号]');
  }
  return text;
}

/** 递归脱敏对象。用于工具结果、快照、诊断条目和持久化轨迹。 */
export function redactSensitiveData(value, options = {}, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitiveText(value, options);
  if (typeof value !== 'object') return value;
  if (depth > 12) return '[已省略:嵌套过深]';

  if (typeof WeakSet !== 'undefined') {
    if (seen.has(value)) return '[已省略:循环引用]';
    seen.add(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveData(item, options, depth + 1, seen));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(normalizedKey(key))) {
      out[key] =
        item === undefined || item === null || item === ''
          ? item
          : typeof item === 'boolean'
            ? item
            : '[已隐藏]';
      continue;
    }
    if (/^(?:href|url|src|action|formAction)$/i.test(key) && typeof item === 'string') {
      out[key] = redactUrl(item);
      continue;
    }
    out[key] = redactSensitiveData(item, options, depth + 1, seen);
  }
  return out;
}

/** 页面快照脱敏：正文、元素标签、href、selectedLabel 等都不例外。 */
export function redactPageSnapshot(snapshot) {
  return redactSensitiveData(snapshot, { maskPersonal: false });
}
