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
        let node = worktree.which("node").unwrap_or_else(|| "node".to_string());
        // Same shape as TypeScript's native server: the compiler CLI, then
        // `--lsp --stdio`. The working directory Zed uses is the worktree.
        // This checkout's sample project is not that root, so the extension
        // adds `--project` itself. An installed project does not need it.
        let mut args = vec!["--lsp".to_string(), "--stdio".to_string()];
        let checkout = "packages/cli/bin/sweetener.mjs";
        if worktree.read_text_file(checkout).is_ok()
            && worktree
                .read_text_file("examples/language-tour/sweetener.json")
                .is_ok()
        {
            args.push("--project".to_string());
            args.push(format!("{root}/examples/language-tour"));
        }
        if worktree.read_text_file(checkout).is_ok() {
            let mut full = vec![format!("{root}/{checkout}")];
            full.append(&mut args);
            return Ok(Command {
                command: node,
                args: full,
                env: Vec::new(),
            });
        }
        let installed = "node_modules/@sweetener/cli/bin/sweetener.mjs";
        if worktree.read_text_file(installed).is_ok() {
            let mut full = vec![format!("{root}/{installed}")];
            full.append(&mut args);
            return Ok(Command {
                command: node,
                args: full,
                env: Vec::new(),
            });
        }
        if let Some(bin) = worktree.which("sweetener") {
            return Ok(Command {
                command: bin,
                args,
                env: Vec::new(),
            });
        }
        Err(concat!(
            "sweetener was not found in node_modules or on PATH. ",
            "Install @sweetener/cli, or set lsp.sweetener-lsp.binary."
        )
        .into())
    }
}

zed::register_extension!(SweetenerExtension);
