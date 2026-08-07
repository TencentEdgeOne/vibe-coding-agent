'use client';

import type { Locale } from '../i18n';

// 语言切换：两个文字按钮 中 / En，选中的高亮为蓝色并略放大，点击切换。
export function LanguageSwitch({
  language,
  onChange,
  ariaLabel,
  className = '',
}: {
  language: Locale;
  onChange: (next: Locale) => void;
  ariaLabel: string;
  className?: string;
}) {
  const itemClass = (active: boolean) =>
    `font-semibold leading-none transition-all ${
      active
        ? 'scale-110 text-primary'
        : 'text-muted-foreground hover:text-foreground'
    }`;
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex items-center gap-1.5 text-sm ${className}`}
    >
      <button
        type="button"
        onClick={() => onChange('zh')}
        aria-pressed={language === 'zh'}
        className={itemClass(language === 'zh')}
      >
        中
      </button>
      <span className="text-muted-foreground/40">/</span>
      <button
        type="button"
        onClick={() => onChange('en')}
        aria-pressed={language === 'en'}
        className={itemClass(language === 'en')}
      >
        En
      </button>
    </div>
  );
}
