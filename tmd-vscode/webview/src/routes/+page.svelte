<script lang="ts">
  import { onMount } from "svelte";
  import "../app.css";

  onMount(() => {
    void import("$lib/editor-app");
  });
</script>

<svelte:head>
  <title>Tanu Markdown Editor</title>
</svelte:head>

<div id="tmd-editor-root" data-state="loading">
  <header class="app-bar">
    <div>
      <div class="eyebrow">Tanu Markdown</div>
      <h1>Document workspace</h1>
    </div>
    <nav class="toolbar" aria-label="Document actions">
      <button id="validate" type="button">Validate</button>
      <button id="add-attachment" type="button">Add attachment</button>
      <button id="export-html" type="button">Export HTML</button>
    </nav>
  </header>
  <main class="layout">
    <section class="workspace-card editor-workspace" aria-label="TMD editing workspace">
      <div class="editor-tabs" role="tablist" aria-label="Document sections">
        <button class="editor-tab" type="button" role="tab" aria-controls="panel-document" aria-selected="true" data-editor-tab="document">Document</button>
        <button class="editor-tab" type="button" role="tab" aria-controls="panel-data" aria-selected="false" tabindex="-1" data-editor-tab="data">Data</button>
        <button class="editor-tab" type="button" role="tab" aria-controls="panel-table" aria-selected="false" tabindex="-1" data-editor-tab="table">Table</button>
        <button class="editor-tab" type="button" role="tab" aria-controls="panel-sources" aria-selected="false" tabindex="-1" data-editor-tab="sources">Sources</button>
        <button class="editor-tab" type="button" role="tab" aria-controls="panel-attachments" aria-selected="false" tabindex="-1" data-editor-tab="attachments">Attachments</button>
        <button class="editor-tab" type="button" role="tab" aria-controls="panel-validation" aria-selected="false" tabindex="-1" data-editor-tab="validation">Validation</button>
      </div>
      <div class="editor-content">
        <section id="panel-document" class="editor-panel" role="tabpanel" data-editor-panel="document">
          <h2>Document</h2>
          <label class="field"><span>Title</span><input id="title" type="text" disabled /></label>
          <div class="field"><span class="field-label">Markdown</span><div id="markdown" class="markdown-editor"></div></div>
          <div class="summary"><div class="metric"><span>Format</span><strong id="format">—</strong></div></div>
        </section>
        <section id="panel-data" class="editor-panel" role="tabpanel" data-editor-panel="data" hidden>
          <h2>SQLite data</h2>
          <p class="section-description">Inspect the embedded database. Editable table data will be added in the table editor.</p>
          <div class="summary"><div class="metric"><span>Database version</span><strong id="database-version">—</strong></div></div>
          <h3>Database objects</h3>
          <ul id="database-objects"></ul>
        </section>
        <section id="panel-table" class="editor-panel table-panel" role="tabpanel" data-editor-panel="table" hidden>
          <h2>Table</h2>
          <p class="section-description">Select a tabular source to inspect its current rows.</p>
          <label class="field table-source-field"><span>Source</span><select id="table-source" disabled></select></label>
          <div class="table-result-heading">
            <p id="table-source-status" class="stale" role="status">Loading sources…</p>
          </div>
          <div id="table-grid-host" class="table-grid-host" hidden></div>
          <section id="formula-program-panel" class="source-script-panel" aria-labelledby="formula-program-heading" hidden>
            <div class="source-script-heading">
              <div>
                <h3 id="formula-program-heading">Formula program</h3>
                <p id="formula-program-input" class="source-script-context"></p>
              </div>
              <p id="formula-program-status" class="stale" role="status"></p>
            </div>
            <p class="formula-help"><code>A1</code> is the first data cell; headers are not rows. Use <code>SUM(B1:B3)</code>, <code>[amount]</code>, <code>[@amount]</code>, or <code>HEADER(B)</code>.</p>
            <div id="formula-column-legend" class="formula-column-legend" aria-label="Formula column references"></div>
            <div id="formula-program-editor" class="source-script-editor"></div>
            <p id="formula-program-error" class="invalid source-script-error" role="alert" hidden></p>
          </section>
          <section id="rhai-script-panel" class="source-script-panel" aria-labelledby="rhai-script-heading" hidden>
            <div class="source-script-heading">
              <div>
                <h3 id="rhai-script-heading">Rhai script</h3>
                <code id="rhai-script-path"></code>
              </div>
              <p id="rhai-script-status" class="stale" role="status"></p>
            </div>
            <div id="rhai-script-editor" class="source-script-editor"></div>
            <p id="rhai-script-error" class="invalid source-script-error" role="alert" hidden></p>
          </section>
        </section>
        <section id="panel-sources" class="editor-panel" role="tabpanel" data-editor-panel="sources" hidden>
          <h2>Data sources</h2>
          <p class="section-description">Define named sources that Markdown views can render.</p>
          <h3>Markdown view references</h3>
          <ul id="data-view-references"></ul>
          <h3>Source definitions</h3>
          <div id="data-source-registry-issue" class="invalid"></div>
          <pre id="data-source-registry-raw" class="registry-raw" hidden></pre>
          <div id="data-sources"></div>
          <div class="data-source-actions">
            <button id="add-sqlite-data-source" type="button">Add SQLite source</button>
            <button id="add-rhai-data-source" type="button">Add Rhai source</button>
            <button id="add-formula-data-source" type="button">Add Formula source</button>
            <button id="apply-data-sources" type="button">Apply source changes</button>
          </div>
          <p id="data-source-status" class="stale"></p>
        </section>
        <section id="panel-attachments" class="editor-panel" role="tabpanel" data-editor-panel="attachments" hidden>
          <h2>Attachments</h2>
          <p class="section-description">Manage files packaged with this document.</p>
          <ul id="attachments"></ul>
        </section>
        <section id="panel-validation" class="editor-panel" role="tabpanel" data-editor-panel="validation" hidden>
          <h2>Validation</h2>
          <p class="section-description">Check document structure, attachments, database versions, and dynamic views.</p>
          <div id="validation"></div>
        </section>
      </div>
    </section>
    <section class="workspace-card preview-card">
      <div class="card-heading"><div><div class="eyebrow">Rendered output</div><h2>Safe preview</h2></div></div>
      <div id="preview" class="preview"></div>
    </section>
  </main>
</div>
