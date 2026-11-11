const MAX_REPLY_CHARS = 1850;

// Lines as a code block, cut to fit Discord's message limit.
function codeBlock(lines) {
  let text = lines.join('\n');
  if (text.length > MAX_REPLY_CHARS) text = `${text.slice(0, MAX_REPLY_CHARS)}\n... (cut, see the bot log)`;
  return `\`\`\`\n${text}\n\`\`\``;
}

module.exports = { codeBlock };
