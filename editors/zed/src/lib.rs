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
        // Zed starts this process with the worktree as its working directory.
        // The CLI reads that directory. This command does not choose a project.
        let args = vec!["--lsp".to_string(), "--stdio".to_string()];
        let checkout = "packages/cli/bin/sweetener.mjs";
        if worktree.read_text_file(checkout).is_ok() {
            return Ok(Command {
                command: node,
                args: vec![format!("{root}/{checkout}"), "--lsp".into(), "--stdio".into()],
                env: Vec::new(),
            });
        }
        let installed = "node_modules/@sweetener/cli/bin/sweetener.mjs";
        if worktree.read_text_file(installed).is_ok() {
            return Ok(Command {
                command: node,
                args: vec![
                    format!("{root}/{installed}"),
                    "--lsp".into(),
                    "--stdio".into(),
                ],
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
