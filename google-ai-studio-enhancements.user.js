// ==UserScript==
// @name         Google AI Studio - Улучшения интерфейса (v8.4)
// @namespace    http://tampermonkey.net/
// @version      8.4
// @description  Добавляет кнопку "Вставить текст" и издает 2-секундный звуковой сигнал по окончании генерации ответа. Устойчив к навигации в SPA.
// @author       Your Name
// @match        *://aistudio.google.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/NikitaKapitanov/AiStudioButton/main/google-ai-studio-enhancements.user.js
// @downloadURL  https://raw.githubusercontent.com/NikitaKapitanov/AiStudioButton/main/google-ai-studio-enhancements.user.js
// ==/UserScript==

(function() {
    'use strict';

    /*
     * Changelog v8.4:
     * - Главный MutationObserver больше не отключается (obs.disconnect() удален).
     * - Скрипт теперь корректно работает при создании нового чата (SPA-навигация).
     * - Логика отслеживания кнопки "Run" адаптирована для пересоздания интерфейса.
     * - Добавлена обратная совместимость для старой и новой версий UI.
     */

    // =================================================================================
    // --- ФУНКЦИЯ 1: КНОПКА "ВСТАВИТЬ ТЕКСТ" ---
    // =================================================================================

    const TEXT_TO_INSERT = 'Создай prompt-запрос для нейросети с указанием ';
    const BUTTON_TEXT = '>>';
    const TEXTAREA_SELECTOR = `
        textarea[aria-label="Enter a prompt"],
        textarea[aria-label="Type something or tab to choose an example prompt"],
        textarea[aria-label="Start typing a prompt"]
    `;
    const BUTTON_CONTAINER_ID = 'custom-insert-button-container';

    /**
     * Пытается найти все элементы и добавить кнопку "Вставить текст".
     * Эта функция идемпотентна: она ничего не делает, если кнопка уже существует.
     * Поддерживает как старую, так и новую версию интерфейса Google AI Studio.
     * Возвращает true, если кнопка существует или была успешно добавлена.
     */
    const tryToAddButton = () => {
        // Проверка на идемпотентность: если кнопка уже есть, ничего не делаем.
        if (document.getElementById(BUTTON_CONTAINER_ID)) return true;

        const textareaElement = document.querySelector(TEXTAREA_SELECTOR);
        if (!textareaElement) return false;

        let parentForInsertion = null;
        let referenceElement = null;

        // --- 1. Попытка для НОВОЙ версии интерфейса ---
        // В новой версии кнопка "Add Media" (ms-add-media-button) находится внутри .button-wrapper
        const newUIAddButton = document.querySelector('ms-add-media-button');
        if (newUIAddButton) {
            parentForInsertion = newUIAddButton.parentElement; // Это .button-wrapper
            referenceElement = newUIAddButton;
        }
        // --- 2. Попытка для СТАРОЙ версии интерфейса (если новая не сработала) ---
        if (!parentForInsertion) {
            const oldUIAddButton = document.querySelector('ms-add-chunk-menu');
            const oldMainContainer = textareaElement.closest('.prompt-input-wrapper-container');
            if (oldUIAddButton && oldMainContainer) {
                parentForInsertion = oldMainContainer;
                referenceElement = oldUIAddButton.closest('.button-wrapper');
            }
        }

        // Если ни одна структура не опознана, выходим
        if (!parentForInsertion || !referenceElement) return false;

        console.log('[Tampermonkey] UI для кнопки найден. Создание кнопки.');

        const buttonWrapper = document.createElement('div');
        buttonWrapper.id = BUTTON_CONTAINER_ID;
        buttonWrapper.className = 'button-wrapper';
        buttonWrapper.style.alignSelf = 'center';
        buttonWrapper.style.marginRight = '4px';

        const button = document.createElement('button');
        button.textContent = BUTTON_TEXT;
        button.style.padding = '4px 8px';
        button.style.height = '32px';
        button.style.border = '1px solid #5f6368';
        button.style.borderRadius = '16px';
        button.style.cursor = 'pointer';
        button.style.backgroundColor = '#3c4043';
        button.style.color = '#e8eaed';
        button.style.fontSize = '12px';
        button.style.whiteSpace = 'nowrap';

        button.onmouseover = () => button.style.backgroundColor = '#4a4e51';
        button.onmouseout = () => button.style.backgroundColor = '#3c4043';

        button.addEventListener('click', (e) => {
            e.preventDefault();
            const currentTextarea = document.querySelector(TEXTAREA_SELECTOR);
            if (currentTextarea && currentTextarea.value.trim() === '') {
                currentTextarea.value = TEXT_TO_INSERT;
                currentTextarea.focus();
                const inputEvent = new Event('input', { bubbles: true });
                currentTextarea.dispatchEvent(inputEvent);
            }
        });

        buttonWrapper.appendChild(button);
        parentForInsertion.insertBefore(buttonWrapper, referenceElement);

        console.log('[Tampermonkey] Кнопка "Вставить текст" успешно встроена.');
        return true;
    };

    // =================================================================================
    // --- ФУНКЦИЯ 2: ЗВУКОВОЕ УВЕДОМЛЕНИЕ ---
    // =================================================================================

    let isGenerating = false;

    /**
     * Издает звуковой сигнал.
     */
    let audioContext;
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
        console.error('[Tampermonkey] AudioContext не поддерживается в этом браузере.');
    }

    const playNotificationSound = () => {
        if (!audioContext) return;
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.type = 'sine';
        oscillator.frequency.value = 520;
        const duration = 2;
        gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.00001, audioContext.currentTime + duration);
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + duration);
    };

    /**
     * Отслеживает состояние кнопки "Run" для определения завершения генерации.
     * Работает с новой и старой версиями интерфейса.
     */
    const checkGenerationStatus = () => {
        let isCurrentlyGenerating = false;

        // 1. Проверка для НОВОЙ версии интерфейса (приоритет).
        // Ищем спиннер, который появляется во время генерации.
        const spinner = document.querySelector('ms-run-button button span.spin');

        if (spinner) {
            isCurrentlyGenerating = true;
        } else {
            // 2. Проверка для СТАРОЙ версии интерфейса (запасной вариант).
            // Ищем иконку "стоп" или заблокированную кнопку с текстом "Stop".
            const stopIcon = document.querySelector('mat-icon[fonticon="stop"]');
            const runButton = document.querySelector('ms-run-button button');

            const isOldUiGenerating = stopIcon || (runButton && (runButton.disabled || runButton.getAttribute('aria-disabled') === 'true') && runButton.textContent.includes('Stop'));

            if (isOldUiGenerating) {
                isCurrentlyGenerating = true;
            }
        }

        // Логика смены состояний: звук воспроизводится только при переходе
        // из состояния "генерирует" в "не генерирует".
        if (!isGenerating && isCurrentlyGenerating) {
            console.log('[Tampermonkey] Генерация началась.');
            isGenerating = true;
        }
        else if (isGenerating && !isCurrentlyGenerating) {

            console.log('[Tampermonkey] Генерация завершена. Сигнал.');
            isGenerating = false;
            playNotificationSound();
        }
    };

    // =================================================================================
    // --- ИНИЦИАЛИЗАЦИЯ И НАБЛЮДЕНИЕ ---
    // =================================================================================

    /**
     * Основной цикл наблюдения за изменениями DOM.
     */
    const observer = new MutationObserver(() => {
        tryToAddButton();
        checkGenerationStatus();
    });

    // Начинаем наблюдение за всем документом, так как это SPA
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Первая попытка запуска при загрузке
    tryToAddButton();
})();
