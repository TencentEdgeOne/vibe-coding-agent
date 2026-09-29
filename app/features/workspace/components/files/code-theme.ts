import type { PrismTheme } from 'prism-react-renderer';

// GitHub Light-inspired syntax theme for the code workspace. These are the one
// place in this surface that keeps raw hex: prism-react-renderer writes the
// values into inline styles and never resolves custom properties, so a
// var(--…) here would render as no colour at all. The panel chrome around it
// reads from the code-surface tokens instead.
export const CODE_THEME: PrismTheme = {
  plain: { color: '#24292f', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#8b949e', fontStyle: 'italic' } },
    { types: ['punctuation'], style: { color: '#24292f' } },
    { types: ['keyword', 'operator', 'boolean', 'important', 'atrule'], style: { color: '#cf222e' } },
    { types: ['function', 'function-variable', 'method'], style: { color: '#8250df' } },
    { types: ['string', 'char', 'attr-value', 'template-string', 'regex', 'url'], style: { color: '#0a7d33' } },
    { types: ['number', 'unit'], style: { color: '#0550ae' } },
    { types: ['tag', 'selector'], style: { color: '#116329' } },
    { types: ['attr-name', 'constant', 'builtin', 'symbol'], style: { color: '#0550ae' } },
    { types: ['class-name', 'maybe-class-name'], style: { color: '#953800' } },
    { types: ['property', 'variable', 'parameter'], style: { color: '#24292f' } },
    { types: ['deleted'], style: { color: '#cf222e' } },
    { types: ['inserted'], style: { color: '#0a7d33' } },
  ],
};

export function prismLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
      return 'scss';
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
    case 'vue':
      return 'markup';
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    default:
      return 'tsx';
  }
}
