// ==UserScript==
// @name         Google AI Studio - Улучшения интерфейса (v8.7)
// @namespace    http://tampermonkey.net/
// @version      8.7
// @description  Добавляет кнопку "Вставить текст", издает звуковой сигнал, фиксирует настройки модели (Temp, Top P) и автоматически выбирает системную инструкцию.
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
     * Changelog v8.7:
     *   1. Кнопка вставки текста.
     *   2. Звуковое уведомление.
     *   3. Фиксация Temperature (0.8) и Top P (0.9).
     *   4. Авто-выбор системной инструкции.
     */

    let lastAppliedModel = null;
    let isApplyingSettings = false;

    // =================================================================================
    // --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
    // =================================================================================

    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

        console.log('[Tampermonkey] Интерфейс обнаружен. Создание кнопки.');

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

        // Сброс флага модели при перерисовке интерфейса (например, кнопка Playground)
        lastAppliedModel = null;
        console.log('[Tampermonkey] Кнопка встроена. Сброс флага модели.');

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
    // --- ФУНКЦИЯ 3: УСТАНОВКА ЗНАЧЕНИЙ (TEMP, TOP P) ---
    // =================================================================================

    const TEMPERATURE_SLIDER_SELECTOR = '[data-test-id="temperatureSliderContainer"] input.mdc-slider__input';
    const TARGET_TEMP_VALUE = '0.8';

    const TOP_P_SLIDER_SELECTOR = '[mattooltip="Probability threshold for top-p sampling"] input.mdc-slider__input';
    const TARGET_TOP_P_VALUE = '0.9';

    const MODEL_NAME_SELECTOR = 'ms-model-selector .model-selector-card .title';

    const forceSetValue = (selector, targetValue, sliderName) => {
        const slider = document.querySelector(selector);
        if (!slider) return;
        setTimeout(() => {
            if (slider.value !== targetValue) {
                console.log(`[Tampermonkey] ${sliderName} is ${slider.value}. Forcing to ${targetValue}.`);
                slider.value = targetValue;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                slider.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, 100);
    };

    // =================================================================================
    // --- ФУНКЦИЯ 4: СОХРАНЕНИЕ ИНСТРУКЦИИ ---
    // =================================================================================

    const STORAGE_KEY_INSTRUCTION = 'tampermonkey_saved_system_instruction_name';
    const SYSTEM_INSTRUCTION_CARD_SELECTOR = '[data-test-system-instructions-card]';
    const CREATE_NEW_INSTRUCTION_TEXT = 'Create new instruction';

    const saveInstructionSelection = (event) => {
        const option = event.target.closest('mat-option');
        if (!option) return;
        const panel = option.closest('[role="listbox"]');
        if (!panel) return;

        const allOptions = panel.querySelectorAll('mat-option');
        let isSystemInstructionPanel = false;
        for (const opt of allOptions) {
            if (opt.textContent.includes(CREATE_NEW_INSTRUCTION_TEXT)) {
                isSystemInstructionPanel = true;
                break;
            }
        }

        if (isSystemInstructionPanel) {
            const instructionNameElement = option.querySelector('.mdc-list-item__primary-text');
            if (instructionNameElement) {
                const instructionName = instructionNameElement.textContent.trim();
                if (!instructionName.includes(CREATE_NEW_INSTRUCTION_TEXT)) {
                    localStorage.setItem(STORAGE_KEY_INSTRUCTION, instructionName);
                    console.log(`[Tampermonkey] Сохранено название инструкции: "${instructionName}"`);
                }
            }
        }
    };

    // =================================================================================
    // --- ФУНКЦИЯ 5: ПРИМЕНЕНИЕ СИСТЕМНОЙ ИНСТРУКЦИИ (ASYNC) ---
    // =================================================================================

    const applySavedInstructionAsync = async () => {
        const savedInstructionName = localStorage.getItem(STORAGE_KEY_INSTRUCTION);
        if (!savedInstructionName) return;

        const instructionCard = document.querySelector(SYSTEM_INSTRUCTION_CARD_SELECTOR);
        if (!instructionCard) return;

        if (instructionCard.dataset.instructionApplied) return;
        instructionCard.dataset.instructionApplied = 'true';

        console.log(`[Tampermonkey] Применяем инструкцию: "${savedInstructionName}"`);
        instructionCard.click();

        await wait(600); // Ждем открытия боковой панели

        const dialogPanel = document.querySelector('.cdk-overlay-pane.ms-sliding-right-panel-dialog');
        if (!dialogPanel) { console.log('[Tampermonkey] Панель инструкций не открылась.'); return; }

        const matSelect = dialogPanel.querySelector('mat-select');
        const closeButton = dialogPanel.querySelector('button[mat-dialog-close]');

        if (!matSelect) {
            if (closeButton) closeButton.click();
            return;
        }

        const currentValueText = matSelect.querySelector('.mat-mdc-select-value-text');
        const currentName = currentValueText ? currentValueText.textContent.trim() : '';

        // Если инструкция уже совпадает, просто закрываем
        if (currentName === savedInstructionName) {
            console.log(`[Tampermonkey] Инструкция уже выбрана.`);
            if (closeButton) closeButton.click();
            await wait(300);
            return;
        }

        // Открываем выпадающий список
        matSelect.click();
        await wait(500);

        // Ищем панель с опциями (она содержит кнопку "Create new instruction")
        const listboxes = document.querySelectorAll('.cdk-overlay-container [role="listbox"]');
        let targetListbox = null;
        for (const lb of listboxes) {
            if (lb.textContent.includes(CREATE_NEW_INSTRUCTION_TEXT)) {
                targetListbox = lb;
                break;
            }
        }

        if (targetListbox) {
            const options = targetListbox.querySelectorAll('mat-option');
            let found = false;
            for (const option of options) {
                const optionText = option.querySelector('.mdc-list-item__primary-text')?.textContent.trim();
                if (optionText === savedInstructionName) {
                    option.click();
                    found = true;
                    break;
                }
            }
            if (!found) {
                // Если не нашли, закрываем дропдаун
                const backdrop = document.querySelector('.cdk-overlay-backdrop');
                if (backdrop) backdrop.click();
            }
        } else {
            const backdrop = document.querySelector('.cdk-overlay-backdrop');
            if (backdrop) backdrop.click();
        }

        await wait(400);
        // Закрываем боковую панель
        if (closeButton) closeButton.click();
        await wait(500);
    };

    /**
     * Главная функция-оркестратор.
     */
    const orchestrateSettings = async () => {
        const modelNameElement = document.querySelector(MODEL_NAME_SELECTOR);
        if (!modelNameElement) return;
        const currentModelName = modelNameElement.textContent.trim();

        if (isApplyingSettings) return;

        if (currentModelName && currentModelName !== lastAppliedModel) {
            isApplyingSettings = true;
            console.log(`[Tampermonkey] === НАЧАЛО ПРИМЕНЕНИЯ НАСТРОЕК (${currentModelName}) ===`);

            lastAppliedModel = currentModelName;

            // 1. Слайдеры (синхронно)
            forceSetValue(TEMPERATURE_SLIDER_SELECTOR, TARGET_TEMP_VALUE, 'Temperature');
            forceSetValue(TOP_P_SLIDER_SELECTOR, TARGET_TOP_P_VALUE, 'Top P');

            // 2. Сброс флага инструкции
            const instructionCard = document.querySelector(SYSTEM_INSTRUCTION_CARD_SELECTOR);
            if (instructionCard) {
                delete instructionCard.dataset.instructionApplied;
            }

            // 3. Системная инструкция (асинхронно)
            await applySavedInstructionAsync();

            console.log(`[Tampermonkey] === ВСЕ НАСТРОЙКИ ПРИМЕНЕНЫ ===`);
            isApplyingSettings = false;
        }
    };

    // =================================================================================
    // --- ИНИЦИАЛИЗАЦИЯ И НАБЛЮДЕНИЕ ---
    // =================================================================================

    const observer = new MutationObserver(() => {
        tryToAddButton();
        checkGenerationStatus();
        orchestrateSettings();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    document.body.addEventListener('click', saveInstructionSelection, true);

    tryToAddButton();
    orchestrateSettings();
})();
