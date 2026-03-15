/**
 * Matrix HTML Formatter
 *
 * Converts markdown and special syntax to Matrix HTML format.
 * Supports spoilers, colors, and other Matrix-specific formatting.
 */

import { MATRIX_HTML_FORMAT, MATRIX_COLORS } from "./types.js";
import { EMOJI_ALIASES as EMOJI_ALIAS_TO_UNICODE } from "../shared/emoji.js";

interface FormattedMessage {
	plain: string;
	html: string;
}

/**
 * Format text with Matrix HTML
 */
export function formatMatrixHTML(text: string): FormattedMessage {
	// Convert emoji shortcodes first (before HTML escaping)
	let plain = convertEmojiShortcodes(text);
	let html = escapeHtml(plain);

	// Convert **bold**
	html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	plain = plain.replace(/\*\*(.+?)\*\*/g, "$1");

	// Convert *italic*
	html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
	plain = plain.replace(/\*(.+?)\*/g, "$1");

	// Convert ```code blocks``` FIRST (before single-backtick, or the single-backtick
	// regex will consume the leading/trailing backticks of the fence and break it)
	html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
		const langAttr = lang ? ` class="language-${lang}"` : "";
		return `<pre><code${langAttr}>${code}</code></pre>`;
	});

	// Convert `code` (single backtick — runs AFTER triple-backtick to avoid interference)
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

	// Convert spoilers ||text||
	html = html.replace(/\|\|(.+?)\|\|/g, '<span data-mx-spoiler>$1</span>');
	plain = plain.replace(/\|\|(.+?)\|\|/g, "[spoiler]");

	// Convert colors {color|text}
	html = html.replace(/\{([^}|]+)\|([^}]+)\}/g, (match, color, content) => {
		const hexColor = getColorHex(color.trim());
		// `content` is already HTML-escaped (escapeHtml ran on the full string above)
		// — do NOT call escapeHtml again or apostrophes become &amp;#039;
		return `<font color="${hexColor}" data-mx-color="${hexColor}">${content}</font>`;
	});
	plain = plain.replace(/\{[^}|]+\|([^}]+)\}/g, "$1");

	// Convert links
	html = html.replace(
		/(https?:\/\/[^\s]+)/g,
		'<a href="$1">$1</a>',
	);

	// Convert newlines to <br>
	html = html.replace(/\n/g, "<br>");

	return { plain, html };
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Get hex color from name or return as-is if already hex
 */
function getColorHex(color: string): string {
	// Check if it's already a hex color
	if (color.startsWith("#")) {
		return color;
	}

	// Check predefined colors
	const upperColor = color.toUpperCase();
	if (upperColor in MATRIX_COLORS) {
		return MATRIX_COLORS[upperColor as keyof typeof MATRIX_COLORS];
	}

	// Default to white if unknown
	return MATRIX_COLORS.WHITE;
}

/**
 * Convert emoji shortcodes to Unicode using the unified emoji map.
 * Handles both :colon: wrapped and plain aliases.
 */
export function convertEmojiShortcodes(text: string): string {
	let result = text;

	// Match :shortcode: pattern and replace with unicode
	result = result.replace(/:([a-z0-9_+-]+):/gi, (match, name) => {
		const lowerName = name.toLowerCase();
		// Try direct lookup
		if (EMOJI_ALIAS_TO_UNICODE[lowerName]) {
			return EMOJI_ALIAS_TO_UNICODE[lowerName];
		}
		// Try with hyphens replaced by underscores
		const withUnderscores = lowerName.replace(/-/g, '_');
		if (EMOJI_ALIAS_TO_UNICODE[withUnderscores]) {
			return EMOJI_ALIAS_TO_UNICODE[withUnderscores];
		}
		// Not found, return original
		return match;
	});

	return result;
}

/**
 * Create a Matrix mention pill
 */
export function createMentionPill(userId: string, displayName?: string): string {
	const name = displayName || userId;
	return `<a href="https://matrix.to/#/${userId}">${escapeHtml(name)}</a>`;
}

/**
 * Create a room mention pill
 */
export function createRoomPill(roomId: string, roomName?: string): string {
	const name = roomName || roomId;
	return `<a href="https://matrix.to/#/${roomId}">${escapeHtml(name)}</a>`;
}

/**
 * Format a quote (blockquote)
 */
export function formatQuote(text: string): FormattedMessage {
	const lines = text.split("\n");
	const plain = lines.map((line) => `> ${line}`).join("\n");
	const html = `<blockquote>${escapeHtml(text).replace(/\n/g, "<br>")}</blockquote>`;
	return { plain, html };
}

/**
 * Format a list
 */
export function formatList(items: string[], ordered = false): FormattedMessage {
	const plain = items.map((item, i) => `${ordered ? `${i + 1}.` : "-"} ${item}`).join("\n");
	const tag = ordered ? "ol" : "ul";
	const htmlItems = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
	const html = `<${tag}>${htmlItems}</${tag}>`;
	return { plain, html };
}
