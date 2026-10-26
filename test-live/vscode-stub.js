// Minimal `vscode` stand-in for live tests run outside the editor: the logger's
// output channel prints to stdout when LIVE_VERBOSE is set.
const verbose = !!process.env.LIVE_VERBOSE;
module.exports = {
  window: {
    createOutputChannel: () => ({
      appendLine: (line) => verbose && console.log(line),
      show() {},
      dispose() {},
    }),
  },
};
