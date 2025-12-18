import { type ReactElement } from 'react';
import { useLanguage } from '../hooks/useLanguage';

export function LanguageSwitcher(): ReactElement {
  const { currentLanguage, changeLanguage } = useLanguage();

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => changeLanguage('en')}
        className={`rounded-lg px-3 py-1 text-sm font-medium transition ${
          currentLanguage === 'en'
            ? 'bg-indigo-500 text-white'
            : 'border border-slate-300 bg-white text-slate-700 hover:border-indigo-400 hover:text-indigo-700'
        }`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => changeLanguage('ja')}
        className={`rounded-lg px-3 py-1 text-sm font-medium transition ${
          currentLanguage === 'ja'
            ? 'bg-indigo-500 text-white'
            : 'border border-slate-300 bg-white text-slate-700 hover:border-indigo-400 hover:text-indigo-700'
        }`}
      >
        JP
      </button>
    </div>
  );
}