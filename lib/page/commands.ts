// Page command facade. Locator, read, overlay and action collaborators own the implementation.
import { pageCommandSession } from './command-session.ts';
import * as readCommands from './command-read.ts';
import * as overlayCommands from './command-overlays.ts';
import * as actionCommands from './command-actions.ts';

export { runJs } from '../application/page/run-js.ts';
export {
  accessibleName,
  describeLookupMiss,
  describeTargetState,
  nameSimilarity,
  resolveElementSelector,
  resolveTargetInfo,
  roleOf,
} from './command-locator.ts';
export { verifyTargets } from './command-read.ts';

export function undoLast() {
  return pageCommandSession.undo();
}

export function resetPageCommands() {
  pageCommandSession.reset();
}

export async function executePageCommand(command: any, params: any) {
  params = params || {};
  switch (command) {
    case 'highlight': return overlayCommands.highlight(params);
    case 'clear_highlights': resetPageCommands(); return { ok: true, result: '已清除页面高亮与样式' };
    case 'scroll_to': return overlayCommands.scrollTo(params);
    case 'scroll_by': return overlayCommands.scrollBy(params);
    case 'outline': return overlayCommands.outline(params);
    case 'set_style': return overlayCommands.setStyle(params);
    case 'click': return actionCommands.click(params);
    case 'get_text': return readCommands.readText(params);
    case 'inspect_element': return readCommands.inspectElement(params);
    case 'read_styles': return readCommands.readStyles(params);
    case 'read_options': return readCommands.readOptions(params);
    case 'extract_table': return readCommands.extractTable(params);
    case 'query_elements': return readCommands.queryElements(params);
    default: return { ok: false, error: '未知页面命令：' + command };
  }
}

export const typeText = actionCommands.typeText;
export const pressKey = actionCommands.pressKey;
export const selectOption = actionCommands.selectOption;
export const checkBox = actionCommands.checkBox;
export const waitForElement = actionCommands.waitForElement;
export const getAttribute = actionCommands.getAttribute;
