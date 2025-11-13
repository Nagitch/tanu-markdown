#![doc = "FFI cdylib wrapper for the tmd-core crate."]

use std::os::raw::c_char;

pub use tmd_core::ffi::*;

macro_rules! keep_symbols {
    ($($name:ident : $ty:ty = $func:path),* $(,)?) => {
        $(
            #[used]
            #[allow(non_upper_case_globals)]
            static $name: $ty = $func;
        )*
    };
}

type Doc = tmd_core::TmdDoc;

type ErrorMessageFn = extern "C" fn() -> *const c_char;
type NewFn = unsafe extern "C" fn(*const c_char) -> *mut Doc;
type ReadFn = unsafe extern "C" fn(*const c_char, i32) -> *mut Doc;
type WriteFn = unsafe extern "C" fn(*const Doc, *const c_char, i32) -> i32;
type GetMarkdownFn = unsafe extern "C" fn(*const Doc) -> *mut c_char;
type SetMarkdownFn = unsafe extern "C" fn(*mut Doc, *const c_char) -> i32;
type FreeDocFn = unsafe extern "C" fn(*mut Doc);
type FreeStringFn = unsafe extern "C" fn(*mut c_char);

keep_symbols!(
    KEEP_TMD_LAST_ERROR_MESSAGE: ErrorMessageFn = tmd_core::ffi::tmd_last_error_message,
    KEEP_TMD_DOC_NEW: NewFn = tmd_core::ffi::tmd_doc_new,
    KEEP_TMD_DOC_READ_FROM_PATH: ReadFn = tmd_core::ffi::tmd_doc_read_from_path,
    KEEP_TMD_DOC_WRITE_TO_PATH: WriteFn = tmd_core::ffi::tmd_doc_write_to_path,
    KEEP_TMD_DOC_GET_MARKDOWN: GetMarkdownFn = tmd_core::ffi::tmd_doc_get_markdown,
    KEEP_TMD_DOC_SET_MARKDOWN: SetMarkdownFn = tmd_core::ffi::tmd_doc_set_markdown,
    KEEP_TMD_DOC_FREE: FreeDocFn = tmd_core::ffi::tmd_doc_free,
    KEEP_TMD_STRING_FREE: FreeStringFn = tmd_core::ffi::tmd_string_free,
);
