/**
 * The one place that knows what a form question IS.
 *
 * Ticket panels, standalone form panels, the dashboard builder and /support forms all describe the
 * same rows in ticket_form_questions, so they all read their vocabulary from here. Adding a type
 * means adding it to TYPES and nowhere else.
 *
 * A Discord modal holds at most FIVE components, full stop — that ceiling is Discord's, not ours,
 * and it is why buildFormModal() truncates rather than erroring: an over-long form should still
 * open and collect the first five answers instead of failing shut. The dashboard warns about the
 * limit while the form is being built, which is the only place a human can actually act on it.
 */
import {
    ActionRowBuilder,
    ChannelSelectMenuBuilder,
    LabelBuilder,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder
} from 'discord.js';

/** Discord's hard cap on components in a single modal. */
export const MODAL_FIELD_LIMIT = 5;
/** Discord's hard cap on options in a single select menu. */
export const SELECT_OPTION_LIMIT = 25;

/**
 * Discord's caps on the two pieces of text a modal field can show.
 *
 * A field label is 45 characters. A Label component's description is 100. Together they mean the
 * longest question a member can ever READ IN FULL is 100 characters — past that, Discord truncates
 * and there is nothing a bot can do about it. So questions are capped at 100 at authoring time
 * rather than silently cut at display time: a builder that accepts a 300-character question and
 * then shows the member half a sentence is lying to the author.
 */
export const LABEL_LIMIT = 45;
export const MAX_QUESTION_LENGTH = 100;

/**
 * A select option inside a MODAL is capped at 45 characters of label — NOT the 100 a select in a
 * normal message gets. discord.js rejects the whole modal if any option label is longer, so an
 * innocuous-looking choice like "yes, I can provide detailed descriptions and logs if requested"
 * (62) makes the pop-up fail to open at all, with no clue as to which option was at fault.
 *
 * Options therefore render as a 45-character heading plus the full choice text in the option's
 * description (which does get 100), and the panel message lists every choice in full on top of
 * that. See buildChoiceOptions.
 */
export const OPTION_LABEL_LIMIT = 45;
export const OPTION_DESCRIPTION_LIMIT = 100;

/**
 * The heading Discord shows above a field.
 *
 * Precedence: the author's own `field_label` if they wrote one, otherwise the question when it
 * fits, otherwise a word-boundary trim of it. The trim carries no ellipsis so it reads as a
 * heading rather than a chopped sentence — but it IS still the question restated, which is why
 * the editor asks for a real label as soon as a question outgrows 45 characters.
 */
export function headingFor(question) {
    const authored = String(question?.field_label ?? '').trim();
    if (authored) return authored.slice(0, LABEL_LIMIT);
    return labelFor(question?.question_text);
}

/** The word-boundary fallback, exported for the dashboard preview to mirror exactly. */
export function labelFor(text) {
    const full = String(text ?? '').trim();
    if (full.length <= LABEL_LIMIT) return full;
    const head = full.slice(0, LABEL_LIMIT);
    const lastSpace = head.lastIndexOf(' ');
    // Fall back to the hard cut only for a single unbroken 45+ character token.
    const trimmed = (lastSpace > 12 ? head.slice(0, lastSpace) : head).replace(/[\s,;:.\-–—]+$/, '');
    return trimmed || head;
}

/**
 * Does the full question need to appear as the field's description?
 *
 * Yes when it cannot fit the heading — either because the author gave a separate short label (so
 * the question lives entirely in the description) or because it is over 45 characters and got
 * trimmed. A short question with no separate label is its own heading and needs nothing more;
 * repeating it there is the duplication this avoids.
 */
export function needsDescription(question) {
    const text = String(question?.question_text ?? question ?? '').trim();
    const authored = String(question?.field_label ?? '').trim();
    if (authored) return authored !== text;
    return text.length > LABEL_LIMIT;
}

/**
 * The stored value for choice #index.
 *
 * Positional rather than the choice text itself, so a choice longer than the 100-character value
 * cap cannot silently record a truncated answer. collectFormAnswers maps it back to the full text
 * using the same question row the modal was built from.
 */
export const optionValue = (index) => `o${index}`;

/** Map a submitted select value back to the choice the member actually picked. */
export function optionTextFor(value, choices) {
    const m = /^o(\d+)$/.exec(String(value ?? ''));
    // Anything that is not a positional token came from a panel posted before this scheme —
    // those carried the choice text as the value, so it is already the answer.
    if (!m) return String(value ?? '');
    return choices[Number(m[1])] ?? String(value ?? '');
}

/**
 * Every answer format a question can use.
 *   needsOptions – the author must supply a choice list
 *   multi        – the answer is a list, so it renders joined
 */
export const TYPES = {
    text:        { label: 'Short Text',       hint: 'One line of free text',                   needsOptions: false, multi: false },
    paragraph:   { label: 'Paragraph',        hint: 'Multi-line free text',                    needsOptions: false, multi: false },
    number:      { label: 'Number',           hint: 'One line, must be numeric',               needsOptions: false, multi: false },
    select:      { label: 'Dropdown',         hint: 'Pick one of your choices',                needsOptions: true,  multi: false },
    multiselect: { label: 'Checkboxes',       hint: 'Pick any number of your choices',         needsOptions: true,  multi: true  },
    user:        { label: 'User Picker',      hint: 'Pick a server member',                    needsOptions: false, multi: false },
    role:        { label: 'Role Picker',      hint: 'Pick a role',                             needsOptions: false, multi: false },
    channel:     { label: 'Channel Picker',   hint: 'Pick a channel',                          needsOptions: false, multi: false }
};

export const TYPE_KEYS = Object.keys(TYPES);

export function isValidType(type) {
    return Object.prototype.hasOwnProperty.call(TYPES, type);
}

/**
 * Parse the stored question_options blob into a clean array of choice labels.
 * Tolerates the two shapes that reach it: a JSON array (what the builder writes) and a
 * newline/comma separated string (what a hand-edited row or an older import may hold).
 */
export function parseOptions(raw) {
    if (!raw) return [];
    let list = [];
    if (Array.isArray(raw)) {
        list = raw;
    } else {
        const str = String(raw).trim();
        if (str.startsWith('[')) {
            try { list = JSON.parse(str); } catch { list = []; }
        }
        if (!list.length) list = str.split(/\r?\n|,/);
    }
    return list
        .map(o => (typeof o === 'string' ? o : o?.label ?? ''))
        .map(o => String(o).trim())
        .filter(Boolean)
        .slice(0, SELECT_OPTION_LIMIT);
}

/** Serialise a choice list back to the stored form. Returns null when the type has no choices. */
export function serialiseOptions(type, raw) {
    if (!TYPES[type]?.needsOptions) return null;
    const list = parseOptions(raw);
    return list.length ? JSON.stringify(list) : null;
}

const truncate = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));

/**
 * Build one modal component for a question.
 * Short labels are a Discord constraint (45 chars); the full question text is carried in the
 * description so a long question is never silently cut down to something ambiguous.
 */
function buildComponent(question) {
    const id = `question_${question.question_id}`;
    const type = isValidType(question.question_type) ? question.question_type : 'text';
    const required = question.is_required === undefined ? true : Boolean(question.is_required);
    const text = String(question.question_text || 'Question');

    if (type === 'text' || type === 'paragraph' || type === 'number') {
        // A question longer than the label cap gets a Label wrapper: a word-boundary heading on
        // top, the question itself verbatim underneath. The inner input carries no label of its
        // own there — inside a Label the component's own label is ignored, and setting both
        // renders the question twice.
        if (needsDescription(question)) {
            const wrapped = new TextInputBuilder()
                .setCustomId(id)
                .setStyle(type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                .setRequired(required);
            if (question.placeholder) wrapped.setPlaceholder(truncate(question.placeholder, 100));
            else if (type === 'number') wrapped.setPlaceholder('Enter a number');
            return new LabelBuilder()
                .setLabel(headingFor(question))
                .setDescription(truncate(text, MAX_QUESTION_LENGTH))
                .setTextInputComponent(wrapped);
        }

        const input = new TextInputBuilder()
            .setCustomId(id)
            .setLabel(text)
            .setStyle(type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(required);
        if (question.placeholder) input.setPlaceholder(truncate(question.placeholder, 100));
        else if (type === 'number') input.setPlaceholder('Enter a number');
        return new ActionRowBuilder().addComponents(input);
    }

    const label = new LabelBuilder().setLabel(headingFor(question));
    if (needsDescription(question)) {
        label.setDescription(truncate(text, MAX_QUESTION_LENGTH));
    } else if (question.placeholder) {
        label.setDescription(truncate(question.placeholder, 100));
    }

    if (type === 'select' || type === 'multiselect') {
        const options = parseOptions(question.question_options);
        if (options.length === 0) {
            // A choice question with no choices cannot render as a select. Fall back to free text
            // rather than throwing away the question entirely.
            return needsDescription(question)
                ? new LabelBuilder()
                    .setLabel(headingFor(question))
                    .setDescription(truncate(text, MAX_QUESTION_LENGTH))
                    .setTextInputComponent(new TextInputBuilder()
                        .setCustomId(id).setStyle(TextInputStyle.Short).setRequired(required))
                : new ActionRowBuilder().addComponents(new TextInputBuilder()
                    .setCustomId(id).setLabel(text).setStyle(TextInputStyle.Short).setRequired(required));
        }
        const menu = new StringSelectMenuBuilder()
            .setCustomId(id)
            .setRequired(required)
            .setMinValues(required ? 1 : 0)
            .setMaxValues(type === 'multiselect' ? options.length : 1)
            .addOptions(options.map((o, index) => {
                const option = new StringSelectMenuOptionBuilder()
                    .setLabel(labelFor(o))          // <= 45, word-boundary, no ellipsis
                    .setValue(optionValue(index));  // positional: never truncated
                // The full wording of a long choice goes in the description, which gets 100.
                if (o.length > OPTION_LABEL_LIMIT) {
                    option.setDescription(truncate(o, OPTION_DESCRIPTION_LIMIT));
                }
                return option;
            }));
        return label.setStringSelectMenuComponent(menu);
    }

    if (type === 'user') {
        return label.setUserSelectMenuComponent(
            new UserSelectMenuBuilder().setCustomId(id).setRequired(required).setMinValues(required ? 1 : 0).setMaxValues(1));
    }
    if (type === 'role') {
        return label.setRoleSelectMenuComponent(
            new RoleSelectMenuBuilder().setCustomId(id).setRequired(required).setMinValues(required ? 1 : 0).setMaxValues(1));
    }
    return label.setChannelSelectMenuComponent(
        new ChannelSelectMenuBuilder().setCustomId(id).setRequired(required).setMinValues(required ? 1 : 0).setMaxValues(1));
}

/**
 * Build a modal for a form's questions.
 * @param {object[]} questions rows from ticket_form_questions
 * @param {string} customId the modal's custom id (the submit handler's routing key)
 * @param {string} title modal title (Discord caps it at 45 chars)
 */
export function buildFormModal(questions, customId, title) {
    const modal = new ModalBuilder()
        .setCustomId(customId)
        .setTitle(truncate(title || 'Form', 45));
    for (const question of questions.slice(0, MODAL_FIELD_LIMIT)) {
        modal.addComponents(buildComponent(question));
    }
    return modal;
}

/**
 * Read a submitted modal back into { questionText: answer }.
 * Every value comes back as a display string so submissions render the same everywhere —
 * mentions for pickers, comma-joined labels for multi-selects.
 *
 * A field that isn't present (optional and left blank) yields '' rather than throwing, which is
 * what makes optional questions actually optional.
 */
export function collectFormAnswers(interaction, questions) {
    const answers = {};
    for (const question of questions.slice(0, MODAL_FIELD_LIMIT)) {
        const id = `question_${question.question_id}`;
        const type = isValidType(question.question_type) ? question.question_type : 'text';
        let value = '';
        try {
            if (type === 'select' || type === 'multiselect') {
                const choices = parseOptions(question.question_options);
                value = Array.from(interaction.fields.getStringSelectValues(id) || [])
                    .map(v => optionTextFor(v, choices))
                    .join(', ');
            } else if (type === 'user') {
                value = Array.from(interaction.fields.getSelectedUsers(id)?.keys() || []).map(uid => `<@${uid}>`).join(', ');
            } else if (type === 'role') {
                value = Array.from(interaction.fields.getSelectedRoles(id)?.keys() || []).map(rid => `<@&${rid}>`).join(', ');
            } else if (type === 'channel') {
                value = Array.from(interaction.fields.getSelectedChannels(id)?.keys() || []).map(cid => `<#${cid}>`).join(', ');
            } else {
                value = interaction.fields.getTextInputValue(id) || '';
            }
        } catch {
            // Field absent: the question was optional and the user skipped it.
            value = '';
        }
        answers[question.question_text] = value;
    }
    return answers;
}

/**
 * Validate answers that carry a rule the modal itself can't enforce.
 * Discord has no numeric input, so 'number' is checked here.
 * @returns {string[]} human-readable problems; empty means the submission is good.
 */
export function validateFormAnswers(answers, questions) {
    const problems = [];
    for (const question of questions.slice(0, MODAL_FIELD_LIMIT)) {
        const value = answers[question.question_text];
        if (question.question_type !== 'number') continue;
        if (!value) continue; // required-ness is Discord's job; blank here means optional+skipped
        if (!/^-?\d+(\.\d+)?$/.test(String(value).trim())) {
            problems.push(`**${question.question_text}** must be a number.`);
        }
    }
    return problems;
}
