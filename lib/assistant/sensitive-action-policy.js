// 支付 / 账号安全动作的硬拦截策略。
//
// 这是**安全边界**，不是提示词建议：命中后无论自动批准、站点信任、会话放行，
// 都不允许执行。策略只看“目标动作语义”和页面安全上下文，不看整页正文，
// 以免文章里出现“支付教程”就把阅读任务拦掉。
import { classifySensitiveField } from '../shared/sensitive-data.js';

const SENSITIVE_PAGE_RE =
  /(?:^|\/)(?:pay|payment|payments|checkout|billing|transfer|withdraw|recharge|wallet|bank|banking|card|cards|oauth|authorize|consent|api[-_]?keys?|tokens?|login|log-in|signin|sign-in|signup|register|password|passwd|reset-password|forgot-password|account\/(?:security|password|privacy|sessions?|authorized-apps)|security)(?:\/|$)/i;

const PAYMENT_COMMIT_RE =
  /(确认支付|立即支付|去支付|支付订单|完成支付|付款|确认付款|立即付款|提交订单|确认下单|立即下单|结算并支付|购买|立即购买|确认购买|转账|确认转账|汇款|提现|确认提现|充值|确认充值|\b(?:pay\s*now|confirm\s*payment|submit\s*payment|place\s*order|complete\s*(?:purchase|payment)|checkout|transfer|withdraw|recharge|buy\s*now|purchase)\b)/i;
const PAYMENT_INSTRUMENT_RE =
  /(绑定.{0,8}(?:卡|账户)|添加.{0,8}(?:卡|账户)|删除.{0,8}(?:卡|账户)|解绑|银行卡|信用卡|借记卡|卡号|有效期|cvv|cvc|安全码|add\s*(?:card|bank)|remove\s*(?:card|bank)|bind\s*(?:card|account)|card\s*number|security\s*code)/i;
const ACCOUNT_SECURITY_RE =
  /(修改密码|重置密码|设置密码|忘记密码|找回密码|登录|登入|退出登录|退出账号|验证码|动态码|短信码|二次验证|两步验证|多因素|身份验证|修改邮箱|修改手机号|更换手机号|更换邮箱|注销账号|删除账号|停用账号|账号恢复|授权|取消授权|api\s*key|access\s*token|refresh\s*token|令牌|密钥|sign\s*in|log\s*in|sign\s*out|change\s*password|reset\s*password|verify\s*identity|two[-\s]?factor|mfa|otp|delete\s*account|recover\s*account|authorize|grant\s*access)/i;
const DESTRUCTIVE_ACCOUNT_RE =
  /(注销|删除账号|停用账号|关闭账号|取消授权|解绑|disconnect|revoke|delete\s*account|deactivate\s*account)/i;
const SAFE_LOOKUP_RE =
  /(记录|历史|详情|说明|帮助|教程|指南|政策|条款|常见问题|order\s*history|records?|details?|help|guide|policy|terms|faq)/i;

const WRITE_TOOLS = new Set([
  'click_element',
  'click_at',
  'type_text',
  'press_key',
  'select_option',
  'check_box',
  'hover_element',
  'drag_element',
  'upload_file',
  'annotate',
  'run_javascript',
  'undo_last_action',
  'handle_dialog',
  'macro',
  'run_userscript',
  'install_userscript',
]);

// 这些工具不改变账号/支付状态，即使页面敏感也允许用于阅读和定位。
const SAFE_ON_SENSITIVE_PAGE = new Set([
  'read_current_page',
  'get_page_snapshot',
  'read_diagnostics',
  'get_element_source',
  'inspect_element',
  'wait_for_element',
  'get_attribute',
  'list_tabs',
  'switch_tab',
  'open_tab',
  'fetch_webpage',
  'web_search',
  'take_screenshot',
  'get_ax_snapshot',
  'list_frames',
  'update_plan',
  'expand_result',
  'get_run_trace',
  'knowledge_read',
  'complete_task',
  'load_skill',
]);

function pagePath(pageUrl) {
  try {
    const u = new URL(String(pageUrl || ''));
    return decodeURIComponent((u.pathname || '') + (u.search || ''));
  } catch (e) {
    return String(pageUrl || '');
  }
}

export function isSensitivePage(pageUrl) {
  return SENSITIVE_PAGE_RE.test(pagePath(pageUrl));
}

function actionText(args, target) {
  const t = target && typeof target === 'object' ? target : {};
  const a = args && typeof args === 'object' ? args : {};
  return [
    t.label,
    t.ariaLabel,
    t.name,
    t.id,
    t.testid,
    t.placeholder,
    t.role,
    t.formAction,
    t.formId,
    t.formName,
    a.role,
    a.name,
    a.text,
    a.selector,
    a.code,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function block(category, userPrompt, evidence, reason) {
  return {
    blocked: true,
    category,
    userPrompt,
    reason: reason || '',
    evidence: String(evidence || '').slice(0, 160),
  };
}

/**
 * 分类一次工具调用。默认允许；只有命中明确的支付/账号安全语义才返回 blocked。
 *
 * @param {Object} input
 * @param {string} input.toolName
 * @param {Object} input.args
 * @param {string} input.pageUrl
 * @param {Object} [input.target] resolveTargetInfo/kbResolvePoint 返回的目标元数据
 */
export function classifySensitiveAction(input = {}) {
  const toolName = String(input.toolName || '');
  const args = input.args && typeof input.args === 'object' ? input.args : {};
  const target = input.target && typeof input.target === 'object' ? input.target : null;
  const pageUrl = String(input.pageUrl || '');
  const sensitivePage = isSensitivePage(pageUrl);
  const targetContextSensitive =
    sensitivePage ||
    isSensitivePage(target && target.formAction) ||
    isSensitivePage(target && target.href);
  const text = actionText(args, target);
  const field = classifySensitiveField(
    Object.assign({}, target || {}, {
      label: (target && target.label) || args.text || args.name || '',
      name: (target && target.name) || args.name || '',
      testid: (target && target.testid) || args.testid || '',
      placeholder: (target && target.placeholder) || args.placeholder || '',
    })
  );

  if (SAFE_ON_SENSITIVE_PAGE.has(toolName)) return { blocked: false };

  // 密码、OTP、卡号/CVV 等敏感字段：输入/选择前就必须拒绝，不能等结果回显后再脱敏。
  if (
    field.sensitive &&
    ['type_text', 'press_key', 'select_option', 'check_box', 'click_element', 'click_at', 'drag_element', 'upload_file'].includes(toolName)
  ) {
    return block(
      field.category === 'payment-card' ? 'payment-instrument' : 'account-credentials',
      '该输入涉及密码、验证码或银行卡等敏感信息。为保证安全，Agent 不会代为填写，请你在当前页面手动完成。',
      field.label || text
    );
  }

  if (PAYMENT_INSTRUMENT_RE.test(text)) {
    return block(
      'payment-instrument',
      '该操作涉及银行卡或支付账户变更。Agent 不会自动执行，请你在当前页面手动完成。',
      text
    );
  }

  if (PAYMENT_COMMIT_RE.test(text) && !SAFE_LOOKUP_RE.test(text)) {
    return block(
      'payment-commit',
      '该操作会确认支付、下单或发生资金变动。Agent 不会自动执行，请你在当前页面手动确认。',
      text
    );
  }

  if (ACCOUNT_SECURITY_RE.test(text) && !SAFE_LOOKUP_RE.test(text) && WRITE_TOOLS.has(toolName)) {
    return block(
      DESTRUCTIVE_ACCOUNT_RE.test(text) ? 'account-destructive' : 'account-security',
      '该操作涉及账号登录、密码、验证或授权安全。Agent 不会自动执行，请你在当前页面手动完成。',
      text
    );
  }

  // 在明确的支付/账号安全页面上，点击提交、代码执行、文件上传、拖拽和
  // 回车提交都不能自动执行；但普通字段填写仍允许，用户需要 Agent 把表单准备好。
  const blockOnSensitivePage =
    ['click_element', 'click_at', 'run_javascript', 'run_userscript', 'install_userscript', 'macro', 'handle_dialog', 'upload_file', 'drag_element'].includes(toolName) ||
    (toolName === 'press_key' && /^(?:enter|numpadenter)$/i.test(String(args.key || '')));
  if (targetContextSensitive && blockOnSensitivePage) {
    return block(
      /pay|checkout|billing|transfer|withdraw|recharge|wallet|bank/i.test(pagePath(pageUrl))
        ? 'payment-page'
        : 'account-security-page',
      '当前页面属于支付或账号安全页面。为避免误操作，Agent 不会执行页面写操作；请你手动完成这一步。',
      pagePath(pageUrl)
    );
  }

  // 外部 MCP 工具的内部行为无法静态审计；敏感页面上只允许内置只读/导航工具。
  if (targetContextSensitive && /^mcp__/.test(toolName)) {
    return block(
      'external-tool-on-sensitive-page',
      '当前页面属于支付或账号安全页面，外部 MCP 工具无法被安全审计，Agent 不会调用。请你手动完成这一步。',
      pagePath(pageUrl)
    );
  }

  // 任意页面上的代码执行 / 用户脚本 / 宏都要检查代码本身是否在操作敏感目标。
  // 这不追求完整静态分析，只拦住明显的“绕过页面工具直接点击/回车”路径。
  if (['run_javascript', 'run_userscript', 'macro'].includes(toolName)) {
    const code = String(args.code || args.name || args.description || '');
    if (PAYMENT_COMMIT_RE.test(code) || PAYMENT_INSTRUMENT_RE.test(code) || ACCOUNT_SECURITY_RE.test(code)) {
      return block(
        'sensitive-code-bypass',
        '该脚本/宏可能触发支付或账号安全操作。Agent 不会代为执行，请你在页面上手动确认。',
        code
      );
    }
  }

  if (toolName === 'handle_dialog' && sensitivePage) {
    return block(
      'payment-confirm-dialog',
      '当前页面涉及支付或账号安全，弹窗确认必须由你本人操作。',
      pagePath(pageUrl)
    );
  }

  return { blocked: false };
}
