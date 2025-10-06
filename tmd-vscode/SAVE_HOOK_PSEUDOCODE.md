# Save Hook Pseudocode (TMD)

1. Split document into markdownText and zipEntries.
2. Encode md_bytes = utf8(markdownText).
3. Build ZIP (STORED, ZIP64) from zipEntries.
4. Set zip.comment = "TMD1\0" + le64(md_bytes.length).
5. Concatenate: tmd_bytes = md_bytes || zip_bytes.
6. Write atomically.
7. On load, find EOCD, read comment, slice head/tail accordingly.
