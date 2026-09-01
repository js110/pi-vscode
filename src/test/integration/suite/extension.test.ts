import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension', () => {
    test('extension is present and activates', async () => {
        const ext = vscode.extensions.getExtension('local.pi-vscode');
        assert.ok(ext, 'Extension should be installed');
        await ext.activate();
        assert.ok(ext.isActive, 'Extension should be active');
    });

    test('commands are registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('pi-agent.newChat'), 'newChat command should exist');
        assert.ok(commands.includes('pi-agent.abort'), 'abort command should exist');
        assert.ok(commands.includes('pi-agent.selectModel'), 'selectModel command should exist');
        assert.ok(commands.includes('pi-agent.focusChat'), 'focusChat command should exist');
        assert.ok(commands.includes('pi-agent.compact'), 'compact command should exist');
    });
});
