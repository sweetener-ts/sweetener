use zed_extension_api::{self as zed, Command, LanguageServerId, Result, Worktree};

struct SweetenerExtension;

impl zed::Extension for SweetenerExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        let root = worktree.root_path();
        let script = format!("{root}/packages/cli/bin/sweetener-lsp.mjs");
        // This repository keeps the language-tour config one directory down.
        // Any other project is rooted at the worktree, which has to contain
        // sweetener.json or tsconfig.json itself.
        let project = if worktree
            .read_text_file("examples/language-tour/sweetener.json")
            .is_ok()
        {
            format!("{root}/examples/language-tour")
        } else {
            root
        };
        let node = worktree.which("node").unwrap_or_else(|| "node".to_string());
        Ok(Command {
            command: node,
            args: vec![script, project],
            env: Vec::new(),
        })
    }
}

zed::register_extension!(SweetenerExtension);
