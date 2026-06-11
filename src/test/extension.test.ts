import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('oridwanbello.r-layout'));
	});

	test('Extension should activate without errors', async () => {
		const ext = vscode.extensions.getExtension('oridwanbello.r-layout');
		assert.ok(ext, 'Extension not found');
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});
});
