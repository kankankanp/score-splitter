import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import ja from './locales/ja.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    lng: 'en', // Default language
    debug: false,

    interpolation: {
      escapeValue: false,
    },

    resources: {
      en: {
        translation: en,
      },
      ja: {
        translation: ja,
      },
    },

    detection: {
      // Detect language from path, localStorage, then navigator
      order: ['path', 'localStorage', 'navigator'],
      lookupFromPathIndex: 0,
      checkWhitelist: true,
      
      // Custom path language detection
      convertDetectedLanguage: (lng) => {
        // Extract language from URL path
        const path = window.location.pathname;
        if (path.startsWith('/ja')) {
          return 'ja';
        }
        return 'en';
      },
    },
    
    // Supported languages
    supportedLngs: ['en', 'ja'],
    
    // Load only supported languages
    nonExplicitSupportedLngs: false,
  });

export default i18n;