import { PLATFORMS } from './constants.ts';

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch (error) {
    return url;
  }
}

export function detectPlatform(url: string): { id: string; name: string } {
  for (const platform of PLATFORMS) {
    if (platform.match.test(url)) return { id: platform.id, name: platform.name };
  }
  return { id: 'other', name: '其他平台' };
}

export function detectType(url: string): string {
  if (url && detectPlatform(url).id !== 'other') return 'wrong';
  return 'article';
}

export function isWebUrl(url: string): boolean {
  return /^https?:/i.test(url);
}

export function isFileUrl(url: string): boolean {
  return /^file:\/\//i.test(String(url || ''));
}

export function isOperableUrl(url: string): boolean {
  return isWebUrl(url) || isFileUrl(url);
}

export function siteKeyOf(url: string): string {
  const value = String(url || '');
  if (isFileUrl(value)) {
    try {
      const pathname = new URL(value).pathname;
      const cut = pathname.lastIndexOf('/');
      return 'file://' + (cut >= 0 ? pathname.slice(0, cut + 1) : '/');
    } catch (error) {
      return value;
    }
  }
  try {
    return new URL(value).origin;
  } catch (error) {
    return '';
  }
}
