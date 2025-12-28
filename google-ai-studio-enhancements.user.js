// ==UserScript==
// @name         Google AI Studio - Улучшения интерфейса (v8.6)
// @namespace    http://tampermonkey.net/
// @version      8.6
// @description  Добавляет кнопку "Вставить текст", издает звуковой сигнал по окончании генерации и устанавливает "Temperature" на 0.8 и "Top P" на 0.9 при смене модели. Устойчив к навигации в SPA.
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
     * Changelog v8.6:
     * - Значения "Temperature" и "Top P" устанавливаются один раз при смене модели.
     * - Добавлено отслеживание смены модели через MutationObserver.
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

    const tryToAddButton = () => {
        if (document.getElementById(BUTTON_CONTAINER_ID)) return true;
        const textareaElement = document.querySelector(TEXTAREA_SELECTOR);
        if (!textareaElement) return false;

        let parentForInsertion = null;
        let referenceElement = null;

        const newUIAddButton = document.querySelector('ms-add-media-button');
        if (newUIAddButton) {
            parentForInsertion = newUIAddButton.parentElement;
            referenceElement = newUIAddButton;
        } else {
            const oldUIAddButton = document.querySelector('ms-add-chunk-menu');
            const oldMainContainer = textareaElement.closest('.prompt-input-wrapper-container');
            if (oldUIAddButton && oldMainContainer) {
                parentForInsertion = oldMainContainer;
                referenceElement = oldUIAddButton.closest('.button-wrapper');
            }
        }
        if (!parentForInsertion || !referenceElement) return false;

        console.log('[Tampermonkey] UI для кнопки найден. Создание кнопки.');

        const buttonWrapper = document.createElement('div');
        buttonWrapper.id = BUTTON_CONTAINER_ID;
        buttonWrapper.className = 'button-wrapper';
        buttonWrapper.style.alignSelf = 'center';
        buttonWrapper.style.marginRight = '4px';

        const button = document.createElement('button');
        button.textContent = BUTTON_TEXT;
        button.style.cssText = 'padding: 4px 8px; height: 32px; border: 1px solid #5f6368; border-radius: 16px; cursor: pointer; background-color: #3c4043; color: #e8eaed; font-size: 12px; white-space: nowrap;';
        button.onmouseover = () => button.style.backgroundColor = '#4a4e51';
        button.onmouseout = () => button.style.backgroundColor = '#3c4043';

        button.addEventListener('click', (e) => {
            e.preventDefault();
            const currentTextarea = document.querySelector(TEXTAREA_SELECTOR);
            if (currentTextarea && currentTextarea.value.trim() === '') {
                currentTextarea.value = TEXT_TO_INSERT;
                currentTextarea.focus();
                currentTextarea.dispatchEvent(new Event('input', { bubbles: true }));
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

    const checkGenerationStatus = () => {
        let isCurrentlyGenerating = false;
        const spinner = document.querySelector('ms-run-button button span.spin');
        if (spinner) {
            isCurrentlyGenerating = true;
        } else {
            const stopIcon = document.querySelector('mat-icon[fonticon="stop"]');
            const runButton = document.querySelector('ms-run-button button');
            const isOldUiGenerating = stopIcon || (runButton && (runButton.disabled || runButton.getAttribute('aria-disabled') === 'true') && runButton.textContent.includes('Stop'));
            if (isOldUiGenerating) {
                isCurrentlyGenerating = true;
            }
        }
        if (!isGenerating && isCurrentlyGenerating) {
            console.log('[Tampermonkey] Генерация началась.');
            isGenerating = true;
        } else if (isGenerating && !isCurrentlyGenerating) {
            console.log('[Tampermonkey] Генерация завершена. Сигнал.');
            isGenerating = false;
            playNotificationSound();
        }
    };

    // =================================================================================
    // --- ФУНКЦИЯ 3: УСТАНОВКА ПАРАМЕТРОВ ПРИ СМЕНЕ МОДЕЛИ ---
    // =================================================================================

    const TEMPERATURE_SLIDER_SELECTOR = '[data-test-id="temperatureSliderContainer"] input.mdc-slider__input';
    const TARGET_TEMP_VALUE = '0.8';

    const TOP_P_SLIDER_SELECTOR = '[mattooltip="Probability threshold for top-p sampling"] input.mdc-slider__input';
    const TARGET_TOP_P_VALUE = '0.9';

    const MODEL_NAME_SELECTOR = 'ms-model-selector .model-selector-card .title';
    let lastAppliedModel = null;

    /**
     * Принудительно устанавливает значение для указанного слайдера.
     * @param {string} selector - CSS-селектор для input-элемента слайдера.
     * @param {string} targetValue - Целевое значение в виде строки.
     * @param {string} sliderName - Имя слайдера для логирования.
     */
    const forceSetValue = (selector, targetValue, sliderName) => {
        const slider = document.querySelector(selector);
        if (!slider) return;

        // Небольшая задержка, чтобы дать Angular время обновить UI после смены модели
        setTimeout(() => {
            if (slider.value !== targetValue) {
                console.log(`[Tampermonkey] ${sliderName} is ${slider.value}. Forcing to ${targetValue}.`);
                slider.value = targetValue;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                slider.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, 100); // 100мс обычно достаточно
    };

    /**
     * Проверяет, изменилась ли модель, и если да, применяет настройки.
     */
    const checkModelAndApplySettings = () => {
        const modelNameElement = document.querySelector(MODEL_NAME_SELECTOR);
        if (!modelNameElement) return;

        const currentModelName = modelNameElement.textContent.trim();

        // Если модель изменилась с момента последнего применения настроек
        if (currentModelName && currentModelName !== lastAppliedModel) {
            console.log(`[Tampermonkey] Модель изменена на "${currentModelName}". Применяем настройки.`);

            forceSetValue(TEMPERATURE_SLIDER_SELECTOR, TARGET_TEMP_VALUE, 'Temperature');
            forceSetValue(TOP_P_SLIDER_SELECTOR, TARGET_TOP_P_VALUE, 'Top P');

            // Запоминаем модель, для которой применили настройки
            lastAppliedModel = currentModelName;
        }
    };

    // =================================================================================
    // --- ИНИЦИАЛИЗАЦИЯ И НАБЛЮДЕНИЕ ---
    // =================================================================================

    const observer = new MutationObserver(() => {
        tryToAddButton();
        checkGenerationStatus();
        checkModelAndApplySettings(); // <-- Эта функция теперь проверяет смену модели
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true // Важно для отслеживания изменения текста в элементе с названием модели
    });

    // Первая попытка запуска при загрузке
    tryToAddButton();
    // Первый вызов для установки значений при загрузке страницы
    checkModelAndApplySettings();
})();
