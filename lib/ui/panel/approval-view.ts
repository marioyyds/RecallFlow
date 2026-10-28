import { esc } from '../../shared/dom/html.ts';

const APPROVAL_LONG_TEXT_FIELD: Record<string, string> = {
  run_javascript: 'code',
  save_skill: 'content',
};

export function describeApprovalRequest(name: any, args: any, risk: any, allowSession: any) {
  const toolArgs = args && typeof args === 'object' ? args : {};
  const longField = APPROVAL_LONG_TEXT_FIELD[name];
  const longText = longField ? String(toolArgs[longField] || '') : '';
  const shownArgs = name === 'type_text'
    ? { ...toolArgs, value: '[输入内容已隐藏]' }
    : longText
      ? { ...toolArgs, [longField]: '[完整内容见下方]' }
      : toolArgs;
  return {
    riskLabel: risk === 'high' ? '高风险' : risk === 'medium' ? '需确认' : '外部操作',
    argsJson: Object.keys(shownArgs).length ? JSON.stringify(shownArgs) : '',
    longText,
    longLabel: !longText
      ? ''
      : name === 'save_skill'
        ? '将要保存的技能正文（会进入今后的系统提示）'
        : '将要执行的完整代码',
    showSession: allowSession !== false,
  };
}

export function renderApprovalPrompt(
  box: any,
  conn: any,
  callId: any,
  name: any,
  args: any,
  risk: any,
  allowSession: any,
  afterRender: () => void = () => {}
): boolean {
  if (!box || !conn) return false;
  const view = describeApprovalRequest(name, args, risk, allowSession);
  const codeBlock = view.longLabel
    ? '<div class="tool-approval-label">' + esc(view.longLabel) +
      '</div><pre class="tool-approval-code">' + esc(view.longText) + '</pre>'
    : '';
  const sessionBtn = view.showSession
    ? '<button class="tool-approve-session" aria-label="本任务内允许此工具">本任务内允许</button>'
    : '';
  box.innerHTML =
    '<div class="tool-approval-title">执行前需要你的确认</div>' +
    '<div class="tool-approval-summary">Agent 请求调用 <span class="tool-approval-tool">' + esc(name) + '</span><span class="tool-approval-risk">' + esc(view.riskLabel) + '</span></div>' +
    (view.argsJson ? '<div class="tool-approval-detail">' + esc(view.argsJson) + '</div>' : '') +
    codeBlock +
    '<div class="tool-approval-actions"><button class="tool-approve" aria-label="仅允许本次工具调用">允许一次</button>' + sessionBtn + '<button class="tool-reject" aria-label="拒绝工具调用">拒绝</button></div>';
  box.style.display = '';
  const decide = (decision: any) => {
    try {
      conn.postMessage({ type: 'tool-approval', callId, decision });
    } catch (error) {}
    box.style.display = 'none';
    box.innerHTML = '';
  };
  box.querySelector('.tool-approve').addEventListener('click', () => decide('once'));
  const sessionEl = box.querySelector('.tool-approve-session');
  if (sessionEl) sessionEl.addEventListener('click', () => decide('session'));
  box.querySelector('.tool-reject').addEventListener('click', () => decide('reject'));
  afterRender();
  return true;
}
