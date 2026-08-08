import { chat_metadata, getCurrentChatId, saveChatConditional, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { download } from '../../../utils.js';

const MODULE_NAME = 'ChatBlockCleaner';
const LEGACY_MODULE_NAME = 'chatBlockCleaner';
const DEFAULT_TAG = 'analyze';

function getSettings() {
    if (!extension_settings[MODULE_NAME] && extension_settings[LEGACY_MODULE_NAME]) {
        extension_settings[MODULE_NAME] = extension_settings[LEGACY_MODULE_NAME];
        delete extension_settings[LEGACY_MODULE_NAME];
        saveSettingsDebounced();
    }
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { tagName: DEFAULT_TAG };
    }
    return extension_settings[MODULE_NAME];
}

function normalizeTagName(value) {
    const input = String(value ?? '').trim();
    const tagMatch = input.match(/^<\s*\/?\s*([A-Za-z][\w:.-]*)[^>]*>$/);
    return tagMatch ? tagMatch[1] : input;
}

function isValidTagName(tagName) {
    return /^[A-Za-z][\w:.-]*$/.test(tagName);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeBlockRegex(tagName) {
    const escapedTag = escapeRegExp(tagName);
    return new RegExp(`<${escapedTag}(?:\\s[^<>]*?)?>[\\s\\S]*?<\\/${escapedTag}\\s*>`, 'gi');
}

function cleanText(text, tagName) {
    return text
        .replace(makeBlockRegex(tagName), '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function scanCurrentChat(tagName) {
    const chat = getContext().chat;
    const changes = [];
    let blockCount = 0;

    if (!Array.isArray(chat)) return { changes, blockCount };

    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        if (!message || typeof message.mes !== 'string') continue;

        const matches = message.mes.match(makeBlockRegex(tagName));
        if (!matches?.length) continue;

        blockCount += matches.length;
        changes.push({
            index,
            originalText: message.mes,
            cleanedText: cleanText(message.mes, tagName),
        });
    }

    return { changes, blockCount };
}

function updateStatus(text, type = '') {
    $('#cbc-status')
        .removeClass('cbc-status-info cbc-status-success cbc-status-error')
        .addClass(type ? `cbc-status-${type}` : '')
        .text(text);
}

function readTagName() {
    const tagName = normalizeTagName($('#cbc-tag-name').val());
    if (!isValidTagName(tagName)) {
        updateStatus('Enter one tag name, such as analyze or <analyze>.', 'error');
        return null;
    }

    $('#cbc-tag-name').val(tagName);
    const settings = getSettings();
    if (settings.tagName !== tagName) {
        settings.tagName = tagName;
        saveSettingsDebounced();
    }
    return tagName;
}

function previewCleanup() {
    const tagName = readTagName();
    if (!tagName) return;

    const { changes, blockCount } = scanCurrentChat(tagName);
    if (blockCount === 0) {
        updateStatus(`No <${tagName}> blocks found in the current chat.`, 'info');
        return;
    }

    const messageWord = changes.length === 1 ? 'message' : 'messages';
    const blockWord = blockCount === 1 ? 'block' : 'blocks';
    updateStatus(`Found ${blockCount} ${blockWord} across ${changes.length} ${messageWord}.`, 'info');
}

function getCleanExportFileName() {
    const sourceName = String(chat_metadata?.file_name || getCurrentChatId() || 'chat')
        .replace(/\.jsonl$/i, '');
    const safeName = sourceName
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim() || 'chat';
    return `${safeName} - cleaned.txt`;
}

function exportCleanedTxt() {
    const tagName = readTagName();
    if (!tagName) return;

    const chat = getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        updateStatus('Open a chat before exporting.', 'error');
        return;
    }

    let transcript = '';
    let exportedMessages = 0;
    let removedBlocks = 0;

    for (const message of chat) {
        if (!message || message.is_system || !message.mes) continue;

        const sourceText = message.extra?.display_text || message.mes;
        if (typeof sourceText !== 'string') continue;

        removedBlocks += sourceText.match(makeBlockRegex(tagName))?.length || 0;
        const cleanedText = cleanText(sourceText, tagName).replace(/\r?\n/g, '\n');
        if (!cleanedText) continue;

        transcript += `${message.name}: ${cleanedText}\n\n`;
        exportedMessages++;
    }

    if (!transcript) {
        updateStatus('The current chat has no printable messages after cleaning.', 'info');
        return;
    }

    download(transcript, getCleanExportFileName(), 'text/plain');
    updateStatus(
        `Exported ${exportedMessages} message${exportedMessages === 1 ? '' : 's'} as TXT; ` +
        `removed ${removedBlocks} <${tagName}> block${removedBlocks === 1 ? '' : 's'} from the export only.`,
        'success',
    );
}

async function cleanCurrentChat() {
    const tagName = readTagName();
    if (!tagName) return;

    const context = getContext();
    const { changes, blockCount } = scanCurrentChat(tagName);
    if (blockCount === 0) {
        updateStatus(`No <${tagName}> blocks found in the current chat.`, 'info');
        return;
    }

    const confirmed = window.confirm(
        `Permanently remove ${blockCount} <${tagName}> block${blockCount === 1 ? '' : 's'} ` +
        `from ${changes.length} message${changes.length === 1 ? '' : 's'} in this chat?`,
    );
    if (!confirmed) return;

    try {
        for (const change of changes) {
            const message = context.chat[change.index];
            message.mes = change.cleanedText;

            // Keep the selected swipe's stored copy in sync without touching alternatives.
            if (Array.isArray(message.swipes) && message.swipes.length > 0) {
                const swipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
                if (typeof message.swipes[swipeId] === 'string') {
                    message.swipes[swipeId] = cleanText(message.swipes[swipeId], tagName);
                }
            }
        }

        await saveChatConditional();

        requestAnimationFrame(() => {
            for (const change of changes) {
                const message = context.chat[change.index];
                try {
                    const html = context.messageFormatting(
                        message.mes,
                        message.name,
                        message.is_system,
                        message.is_user,
                        change.index,
                    );
                    $(`#chat .mes[mesid="${change.index}"] .mes_text`).html(html);
                } catch (error) {
                    console.debug('[ChatBlockCleaner] Message redraw skipped:', error);
                }
            }
        });

        updateStatus(
            `Removed ${blockCount} block${blockCount === 1 ? '' : 's'} from ` +
            `${changes.length} message${changes.length === 1 ? '' : 's'} and saved the chat.`,
            'success',
        );
    } catch (error) {
        console.error('[ChatBlockCleaner] Cleanup failed:', error);
        updateStatus('Cleanup failed. The chat may not have been saved; check the console.', 'error');
    }
}

function panelHtml() {
    return `
        <div id="cbc-panel" class="cbc-panel">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>ChatBlockCleaner</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="flex-container flexFlowColumn cbc-content">
                        <label for="cbc-tag-name">Outer tag to remove</label>
                        <input id="cbc-tag-name" class="text_pole" type="text" placeholder="analyze">
                        <small>Removes each complete tag block and everything inside it from the current chat.</small>
                        <div class="cbc-actions">
                            <div id="cbc-scan" class="menu_button">Scan current chat</div>
                            <div id="cbc-export" class="menu_button">Export cleaned TXT</div>
                            <div id="cbc-clean" class="menu_button cbc-clean-button">Remove blocks</div>
                        </div>
                        <div id="cbc-status" class="cbc-status" aria-live="polite"></div>
                    </div>
                </div>
            </div>
        </div>`;
}

function getSettingsColumn() {
    const left = document.getElementById('extensions_settings');
    const right = document.getElementById('extensions_settings2');
    if (left && right) return right.children.length > left.children.length ? left : right;
    return left || right;
}

function init() {
    if ($('#cbc-panel').length) return;

    const target = getSettingsColumn();
    if (!target) return;

    $(target).append(panelHtml());
    $('#cbc-tag-name').val(getSettings().tagName || DEFAULT_TAG);
    $('#cbc-scan').on('click', previewCleanup);
    $('#cbc-export').on('click', exportCleanedTxt);
    $('#cbc-clean').on('click', cleanCurrentChat);
    $('#cbc-tag-name').on('keydown', event => {
        if (event.key === 'Enter') previewCleanup();
    });

    console.log('[ChatBlockCleaner] loaded');
}

jQuery(init);
