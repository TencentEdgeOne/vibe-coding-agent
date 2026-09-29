'use client';

import { useEffect, useRef, useState } from 'react';
import {
  TENCENT_CLOUD_CONTACT_URL,
  extractProjectName,
  getContactUrl,
  getMakersModelsDocsUrl,
  getTemplateDeployUrl,
} from '@/app/lib/conversation';
import { LANGUAGE_STORAGE_KEY, type Locale } from '@/app/i18n';
import { resolveInitialLocale } from '@/app/i18n/detect';

function setDocumentLanguage(language: Locale) {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
}

export function usePlatformLinks(language: Locale, setLanguage: (locale: Locale) => void) {
  const [contactUrl, setContactUrl] = useState(TENCENT_CLOUD_CONTACT_URL);
  const [templateDeployUrl, setTemplateDeployUrl] = useState(() => getTemplateDeployUrl(''));
  const [makersModelsDocsUrl, setMakersModelsDocsUrl] = useState(() => getMakersModelsDocsUrl(''));
  const languageResolvedRef = useRef(false);

  function changeLanguage(next: Locale) {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    setLanguage(next);
  }

  useEffect(() => {
    const { domain } = extractProjectName();
    setContactUrl(getContactUrl(domain));
    setTemplateDeployUrl(getTemplateDeployUrl(domain));
    setMakersModelsDocsUrl(getMakersModelsDocsUrl(domain));
  }, []);

  useEffect(() => {
    if (!languageResolvedRef.current) return;
    setDocumentLanguage(language);
  }, [language]);

  useEffect(() => {
    const navigatorLanguages = window.navigator.languages?.length
      ? window.navigator.languages
      : [window.navigator.language];
    const next = resolveInitialLocale({
      stored: window.localStorage.getItem(LANGUAGE_STORAGE_KEY),
      languages: navigatorLanguages,
      domain: window.location.hostname,
    });

    languageResolvedRef.current = true;
    setDocumentLanguage(next);
    setLanguage(next);
  }, [setLanguage]);

  return {
    contactUrl,
    templateDeployUrl,
    makersModelsDocsUrl,
    changeLanguage,
  };
}
