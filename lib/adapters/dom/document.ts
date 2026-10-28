import type { DomPort } from '../../application/ports/dom.ts';

export interface DocumentLike {
  createElement(tagName: string): any;
  getElementById(id: string): any;
  querySelector(selector: string): any;
  activeElement: any;
  visibilityState: string;
  body?: any;
}

/** Thin DOM adapter so UI controllers can be exercised without a browser global. */
export class BrowserDocumentAdapter implements DomPort {
  private readonly documentApi: DocumentLike;

  constructor(documentApi: DocumentLike) {
    this.documentApi = documentApi;
  }

  createElement(tagName: string): any {
    return this.documentApi.createElement(tagName);
  }

  append(parent: any, child: any): void {
    parent.appendChild(child);
  }

  getElementById(id: string): any {
    return this.documentApi.getElementById(id);
  }

  querySelector(selector: string, root?: any): any {
    return (root || this.documentApi).querySelector(selector);
  }

  getActiveElement(): any {
    return this.documentApi.activeElement;
  }

  getVisibilityState(): string {
    return String(this.documentApi.visibilityState || '');
  }
}

export function createBrowserDocumentAdapter(documentApi: DocumentLike = document): DomPort {
  return new BrowserDocumentAdapter(documentApi);
}
