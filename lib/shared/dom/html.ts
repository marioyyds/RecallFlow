import { ITEM_TYPES, STAR_LEVELS } from '../constants.ts';

export function typeInfo(id: string) {
  return ITEM_TYPES.find((t) => t.id === id) || ITEM_TYPES[0];
}

export function typeColor(id: string) {
  return typeInfo(id).color;
}

export function starColor(n: number | string) {
  return (STAR_LEVELS[Number(n)] || STAR_LEVELS[2]).color;
}

export function starBarHtml(n: number | string, interactive?: boolean) {
  const level = Math.max(1, Math.min(3, Number(n) || 1));
  const group = interactive ? ' role="radiogroup" aria-label="重要程度"' : '';
  let h = `<span class="star-bar${interactive ? ' interactive' : ''}"${group}>`;
  for (let i = 1; i <= 3; i++) {
    const on = i <= level;
    const cell = interactive
      ? ` role="radio" aria-checked="${on}" aria-label="${i} 星" tabindex="${on ? 0 : -1}" data-star="${i}"`
      : ` data-star="${i}"`;
    h += `<span class="star-cell${on ? ' on' : ''}" style="--star-level:${starColor(i)}"${cell}>★</span>`;
  }
  h += '</span>';
  return h;
}

/**
 * 为可交互星级（radiogroup）绑定键盘交互，满足 WCAG 2.1 键盘可达性。
 * - 方向键 / Home / End 在星星间移动（roving tabindex）
 * - 空格 / 回车 选中当前聚焦的星
 * 视觉与 aria 状态就地更新（不触发整列表重渲染，避免焦点/滚动丢失）。
 * @param {HTMLElement} root - 监听键盘事件的容器（如 #list 或 document）
 * @param {(value:number, cell:HTMLElement)=>void} onSelect - 选中回调，cell 为被聚焦的星星元素
 */
export function bindStarKeyboard(root: HTMLElement | Document, onSelect: (value: number, cell: HTMLElement) => void) {
  root.addEventListener('keydown', (e: Event) => {
    const cell = (e.target as Element | null)?.closest('.star-cell[role="radio"]') as HTMLElement | null;
    if (!cell) return;
    const group = cell.parentElement as HTMLElement;
    const cells = Array.from(group.querySelectorAll<HTMLElement>('.star-cell'));
    const max = cells.length - 1;
    let idx = cells.indexOf(cell);
    switch ((e as KeyboardEvent).key) {
      case 'ArrowRight':
      case 'ArrowUp':
        idx = Math.min(max, idx + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        idx = Math.max(0, idx - 1);
        break;
      case 'Home':
        idx = 0;
        break;
      case 'End':
        idx = max;
        break;
      case ' ':
      case 'Enter':
        e.preventDefault();
        onSelect(Number(cell.dataset.star), cell);
        return;
      default:
        return;
    }
    e.preventDefault();
    cells.forEach((c, i) => {
      const on = i <= idx;
      c.classList.toggle('on', on);
      c.tabIndex = i === idx ? 0 : -1;
      c.setAttribute('aria-checked', String(on));
    });
    cells[idx].focus();
    onSelect(idx + 1, cells[idx]);
  });
}

export function levelNameHtml(n: number | string) {
  const st = STAR_LEVELS[Math.max(1, Math.min(3, Number(n) || 1))];
  return `<span class="level-name" style="color:${st.color}">${st.name}</span>`;
}

export function typeBadgeHtml(type: string) {
  const t = typeInfo(type);
  return `<span class="type-badge" style="color:${t.color};background:${t.color}1A;border:1px solid ${t.color}40">${t.name}</span>`;
}

export function tagsHtml(tags: string[] | null | undefined) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return `<span class="tag-list">${tags
    .map((t) => `<span class="tag-chip">${esc(t)}</span>`)
    .join('')}</span>`;
}

export function esc(s: unknown): string {
  // 保留调用点内联对象：索引只靠类型断言通过，产物与改写前逐字节相同。
  return String(s).replace(/[&<>"']/g, (c: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

export function platformColor(id: string) {
  return id === 'other' ? '#95a5a6' : '#4a90d9';
}
