import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';

export const useLanguage = () => {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  // Extract current language from path
  const getCurrentLanguage = (): string => {
    const pathSegments = location.pathname.split('/').filter(Boolean);
    if (pathSegments.length > 0 && pathSegments[0] === 'ja') {
      return 'ja';
    }
    return 'en';
  };

  // Change language and update URL
  const changeLanguage = (newLanguage: string) => {
    const currentLang = getCurrentLanguage();
    if (currentLang === newLanguage) return;

    let newPath = location.pathname;
    
    if (currentLang === 'ja') {
      // Remove /ja prefix
      newPath = newPath.replace(/^\/ja/, '') || '/';
    }
    
    if (newLanguage === 'ja') {
      // Add /ja prefix
      newPath = '/ja' + newPath;
    }

    // Update i18n language
    i18n.changeLanguage(newLanguage);
    
    // Navigate to new path
    navigate(newPath + location.search + location.hash, { replace: true });
  };

  // Get path without language prefix
  const getPathWithoutLanguage = (): string => {
    const currentLang = getCurrentLanguage();
    if (currentLang === 'ja') {
      return location.pathname.replace(/^\/ja/, '') || '/';
    }
    return location.pathname;
  };

  // Get full path for specific language
  const getPathForLanguage = (language: string): string => {
    const pathWithoutLang = getPathWithoutLanguage();
    if (language === 'ja') {
      return '/ja' + pathWithoutLang;
    }
    return pathWithoutLang;
  };

  // Navigate to path with current language prefix
  const navigateWithLanguage = (path: string) => {
    const currentLang = getCurrentLanguage();
    if (currentLang === 'ja') {
      navigate('/ja' + path);
    } else {
      navigate(path);
    }
  };

  useEffect(() => {
    const currentLang = getCurrentLanguage();
    if (i18n.language !== currentLang) {
      i18n.changeLanguage(currentLang);
    }
  }, [location.pathname, i18n]);

  return {
    currentLanguage: getCurrentLanguage(),
    changeLanguage,
    getPathWithoutLanguage,
    getPathForLanguage,
    navigateWithLanguage,
  };
};