export interface DomPort {
  createElement(tagName: string): any;
  append(parent: any, child: any): void;
  getElementById(id: string): any;
  querySelector(selector: string, root?: any): any;
  getActiveElement(): any;
  getVisibilityState(): string;
}
