//! Bounded spreadsheet-style Formula parsing and evaluation.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use tmd_data::{DataScalar, DataTable};

/// Maximum accepted Formula program size in UTF-8 bytes.
pub const MAX_FORMULA_PROGRAM_BYTES: usize = 256 * 1024;
const MAX_FORMULA_ASSIGNMENTS: usize = 2_000;
const MAX_EXPRESSION_NODES: usize = 1_024;
const MAX_EXPRESSION_DEPTH: usize = 64;
const MAX_EVALUATION_STEPS: usize = 100_000;
const MAX_FORMULA_TEXT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CellRef {
    column: usize,
    row: usize,
}

impl CellRef {
    /// Create a cell reference from zero-based column and row indexes.
    ///
    /// Returns `None` when either index cannot be represented safely as a
    /// one-based spreadsheet coordinate.
    #[must_use]
    pub const fn from_indexes(column: usize, row: usize) -> Option<Self> {
        if column == usize::MAX || row == usize::MAX {
            None
        } else {
            Some(Self { column, row })
        }
    }

    /// Return the zero-based column index.
    #[must_use]
    pub const fn column_index(self) -> usize {
        self.column
    }

    /// Return the zero-based row index.
    #[must_use]
    pub const fn row_index(self) -> usize {
        self.row
    }
}

impl fmt::Display for CellRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut column = self.column + 1;
        let mut letters = Vec::new();
        while column > 0 {
            let remainder = (column - 1) % 26;
            letters.push((b'A' + remainder as u8) as char);
            column = (column - 1) / 26;
        }
        for letter in letters.iter().rev() {
            write!(formatter, "{letter}")?;
        }
        write!(formatter, "{}", self.row + 1)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Span {
    line: usize,
    start: usize,
    end: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FormulaErrorKind {
    Ref,
    Value,
    DivZero,
    Name,
    Cycle,
    Limit,
}

impl FormulaErrorKind {
    fn code(self) -> &'static str {
        match self {
            Self::Ref => "#REF!",
            Self::Value => "#VALUE!",
            Self::DivZero => "#DIV/0!",
            Self::Name => "#NAME?",
            Self::Cycle => "#CYCLE!",
            Self::Limit => "#LIMIT!",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormulaError {
    kind: FormulaErrorKind,
    message: String,
    span: Span,
    target: Option<CellRef>,
}

impl FormulaError {
    fn new(kind: FormulaErrorKind, span: Span, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            span,
            target: None,
        }
    }

    fn at_target(mut self, target: CellRef) -> Self {
        if self.target.is_none() {
            self.target = Some(target);
        }
        self
    }

    /// Return the spreadsheet-style error code such as `#REF!`.
    #[must_use]
    pub fn code(&self) -> &'static str {
        self.kind.code()
    }

    /// Return the one-based source line where the diagnostic begins.
    #[must_use]
    pub const fn line(&self) -> usize {
        self.span.line
    }

    /// Return the one-based Unicode-scalar source column where the diagnostic begins.
    #[must_use]
    pub const fn column(&self) -> usize {
        self.span.start + 1
    }

    /// Return the one-based exclusive Unicode-scalar source column where the diagnostic ends.
    #[must_use]
    pub const fn end_column(&self) -> usize {
        self.span.end + 1
    }

    /// Return the human-readable diagnostic detail without its code or location.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Return the target cell when evaluation could associate the failure with one.
    #[must_use]
    pub const fn target(&self) -> Option<CellRef> {
        self.target
    }
}

impl fmt::Display for FormulaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(target) = self.target {
            write!(formatter, "cell `{target}`: ")?;
        }
        write!(
            formatter,
            "{} at line {}, column {}: {}",
            self.kind.code(),
            self.span.line,
            self.span.start + 1,
            self.message
        )
    }
}

impl std::error::Error for FormulaError {}

/// Parsed Formula program with an opaque, dependency-aware representation.
#[derive(Clone, Debug)]
pub struct FormulaProgram {
    assignments: BTreeMap<CellRef, Assignment>,
}

impl FormulaProgram {
    /// Return the number of assigned cells in the program.
    #[must_use]
    pub fn assignment_count(&self) -> usize {
        self.assignments.len()
    }
}

#[derive(Clone, Debug)]
struct Assignment {
    target_span: Span,
    expression: Expr,
}

#[derive(Clone, Debug)]
struct Expr {
    kind: ExprKind,
    span: Span,
}

#[derive(Clone, Debug)]
enum ExprKind {
    Scalar(DataScalar),
    Cell(CellRef),
    Range(CellRef, CellRef),
    NamedColumn {
        name: String,
        current_row: bool,
    },
    Identifier(String),
    Unary {
        operator: UnaryOperator,
        expression: Box<Expr>,
    },
    Binary {
        operator: BinaryOperator,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Call {
        name: String,
        arguments: Vec<Expr>,
    },
}

#[derive(Clone, Copy, Debug)]
enum UnaryOperator {
    Plus,
    Minus,
}

#[derive(Clone, Copy, Debug)]
enum BinaryOperator {
    Add,
    Subtract,
    Multiply,
    Divide,
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
}

#[derive(Clone, Debug)]
enum TokenKind {
    Number(String),
    String(String),
    Identifier(String),
    Cell(CellRef),
    NamedColumn { name: String, current_row: bool },
    Plus,
    Minus,
    Star,
    Slash,
    Equal,
    EqualEqual,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    Colon,
    Comma,
    LeftParen,
    RightParen,
    End,
}

#[derive(Clone, Debug)]
struct Token {
    kind: TokenKind,
    span: Span,
}

/// Parse and validate one Formula assignment program.
pub fn parse_formula_program(program: &str) -> Result<FormulaProgram, FormulaError> {
    if program.len() > MAX_FORMULA_PROGRAM_BYTES {
        return Err(FormulaError::new(
            FormulaErrorKind::Limit,
            Span {
                line: 1,
                start: 0,
                end: 0,
            },
            format!("program exceeds {MAX_FORMULA_PROGRAM_BYTES} bytes"),
        ));
    }

    let mut assignments = BTreeMap::new();
    for (line_index, raw_line) in program.lines().enumerate() {
        let line_number = line_index + 1;
        let line = strip_comment(raw_line);
        if line.trim().is_empty() {
            continue;
        }
        if assignments.len() >= MAX_FORMULA_ASSIGNMENTS {
            return Err(FormulaError::new(
                FormulaErrorKind::Limit,
                Span {
                    line: line_number,
                    start: 0,
                    end: line.chars().count(),
                },
                format!("program exceeds {MAX_FORMULA_ASSIGNMENTS} assignments"),
            ));
        }

        let mut parser = ExpressionParser::new(line, line_number)?;
        let (target, target_span) = parser.parse_target()?;
        parser.require_assignment_equal()?;
        parser.consume_optional_expression_equal()?;
        let expression = parser.parse_complete_expression()?;
        if assignments
            .insert(
                target,
                Assignment {
                    target_span,
                    expression,
                },
            )
            .is_some()
        {
            return Err(FormulaError::new(
                FormulaErrorKind::Ref,
                target_span,
                format!("formula target `{target}` is assigned more than once"),
            ));
        }
    }

    if assignments.is_empty() {
        return Err(FormulaError::new(
            FormulaErrorKind::Value,
            Span {
                line: 1,
                start: 0,
                end: 0,
            },
            "program requires at least one cell assignment",
        ));
    }
    Ok(FormulaProgram { assignments })
}

fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut index = 0;
    let mut quoted = false;
    let mut escaped = false;
    let mut bracket_depth = 0usize;
    while index + 1 < bytes.len() {
        match bytes[index] {
            b'"' if !escaped && bracket_depth == 0 => quoted = !quoted,
            b'[' if !quoted => bracket_depth += 1,
            b']' if !quoted => bracket_depth = bracket_depth.saturating_sub(1),
            b'/' if bytes[index + 1] == b'/' && !quoted && bracket_depth == 0 => {
                return &line[..index];
            }
            _ => {}
        }
        escaped = quoted && bytes[index] == b'\\' && !escaped;
        if bytes[index] != b'\\' {
            escaped = false;
        }
        index += 1;
    }
    line
}

struct ExpressionParser {
    tokens: Vec<Token>,
    cursor: usize,
    node_count: usize,
}

impl ExpressionParser {
    fn new(input: &str, line: usize) -> Result<Self, FormulaError> {
        Ok(Self {
            tokens: Lexer::new(input, line).tokenize()?,
            cursor: 0,
            node_count: 0,
        })
    }

    fn parse_target(&mut self) -> Result<(CellRef, Span), FormulaError> {
        let token = self.advance().clone();
        match token.kind {
            TokenKind::Cell(cell) => Ok((cell, token.span)),
            _ => Err(FormulaError::new(
                FormulaErrorKind::Ref,
                token.span,
                "each program line must begin with a target cell such as `C1`",
            )),
        }
    }

    fn require_assignment_equal(&mut self) -> Result<(), FormulaError> {
        let token = self.advance().clone();
        if matches!(token.kind, TokenKind::Equal) {
            Ok(())
        } else {
            Err(FormulaError::new(
                FormulaErrorKind::Value,
                token.span,
                "expected `=` after the target cell",
            ))
        }
    }

    fn consume_optional_expression_equal(&mut self) -> Result<(), FormulaError> {
        if matches!(self.peek().kind, TokenKind::Equal) {
            self.advance();
        }
        if matches!(self.peek().kind, TokenKind::End) {
            return Err(FormulaError::new(
                FormulaErrorKind::Value,
                self.peek().span,
                "cell assignment requires an expression",
            ));
        }
        Ok(())
    }

    fn parse_complete_expression(&mut self) -> Result<Expr, FormulaError> {
        let expression = self.parse_expression(0, 0)?;
        if !matches!(self.peek().kind, TokenKind::End) {
            return Err(FormulaError::new(
                FormulaErrorKind::Value,
                self.peek().span,
                "unexpected token after expression",
            ));
        }
        Ok(expression)
    }

    fn parse_expression(
        &mut self,
        minimum_precedence: u8,
        depth: usize,
    ) -> Result<Expr, FormulaError> {
        if depth > MAX_EXPRESSION_DEPTH {
            return Err(FormulaError::new(
                FormulaErrorKind::Limit,
                self.peek().span,
                format!("expression nesting exceeds {MAX_EXPRESSION_DEPTH}"),
            ));
        }
        let mut left = self.parse_prefix(depth + 1)?;
        loop {
            if matches!(self.peek().kind, TokenKind::Colon) {
                let precedence = 7;
                if precedence < minimum_precedence {
                    break;
                }
                let colon = self.advance().clone();
                let right = self.parse_prefix(depth + 1)?;
                let (start, end) = match (&left.kind, &right.kind) {
                    (ExprKind::Cell(start), ExprKind::Cell(end)) => (*start, *end),
                    _ => {
                        return Err(FormulaError::new(
                            FormulaErrorKind::Ref,
                            colon.span,
                            "range endpoints must both be cell references",
                        ))
                    }
                };
                let span = Span {
                    line: left.span.line,
                    start: left.span.start,
                    end: right.span.end,
                };
                left = self.node(ExprKind::Range(start, end), span)?;
                continue;
            }

            let Some((operator, precedence)) = binary_operator(&self.peek().kind) else {
                break;
            };
            if precedence < minimum_precedence {
                break;
            }
            self.advance();
            let right = self.parse_expression(precedence + 1, depth + 1)?;
            let span = Span {
                line: left.span.line,
                start: left.span.start,
                end: right.span.end,
            };
            left = self.node(
                ExprKind::Binary {
                    operator,
                    left: Box::new(left),
                    right: Box::new(right),
                },
                span,
            )?;
        }
        Ok(left)
    }

    fn parse_prefix(&mut self, depth: usize) -> Result<Expr, FormulaError> {
        let token = self.advance().clone();
        match token.kind {
            TokenKind::Number(number) => {
                let scalar = if number.contains(['.', 'e', 'E']) {
                    let value = number.parse::<f64>().map_err(|_| {
                        FormulaError::new(
                            FormulaErrorKind::Value,
                            token.span,
                            "invalid real literal",
                        )
                    })?;
                    if !value.is_finite() {
                        return Err(FormulaError::new(
                            FormulaErrorKind::Value,
                            token.span,
                            "real literal must be finite",
                        ));
                    }
                    DataScalar::Real(value)
                } else {
                    DataScalar::Integer(number.parse::<i64>().map_err(|_| {
                        FormulaError::new(
                            FormulaErrorKind::Value,
                            token.span,
                            "integer literal is outside the signed 64-bit range",
                        )
                    })?)
                };
                self.node(ExprKind::Scalar(scalar), token.span)
            }
            TokenKind::String(value) => {
                self.node(ExprKind::Scalar(DataScalar::String(value)), token.span)
            }
            TokenKind::Cell(cell) => self.node(ExprKind::Cell(cell), token.span),
            TokenKind::NamedColumn { name, current_row } => {
                self.node(ExprKind::NamedColumn { name, current_row }, token.span)
            }
            TokenKind::Identifier(name) => {
                if matches!(self.peek().kind, TokenKind::LeftParen) {
                    self.advance();
                    let mut arguments = Vec::new();
                    if !matches!(self.peek().kind, TokenKind::RightParen) {
                        loop {
                            arguments.push(self.parse_expression(0, depth + 1)?);
                            if matches!(self.peek().kind, TokenKind::Comma) {
                                self.advance();
                                continue;
                            }
                            break;
                        }
                    }
                    let close = self.advance().clone();
                    if !matches!(close.kind, TokenKind::RightParen) {
                        return Err(FormulaError::new(
                            FormulaErrorKind::Value,
                            close.span,
                            "expected `)` after function arguments",
                        ));
                    }
                    self.node(
                        ExprKind::Call { name, arguments },
                        Span {
                            line: token.span.line,
                            start: token.span.start,
                            end: close.span.end,
                        },
                    )
                } else {
                    let upper = name.to_ascii_uppercase();
                    let kind = match upper.as_str() {
                        "TRUE" => ExprKind::Scalar(DataScalar::Boolean(true)),
                        "FALSE" => ExprKind::Scalar(DataScalar::Boolean(false)),
                        "NULL" => ExprKind::Scalar(DataScalar::Null),
                        _ => ExprKind::Identifier(name),
                    };
                    self.node(kind, token.span)
                }
            }
            TokenKind::Plus | TokenKind::Minus => {
                let operator = if matches!(token.kind, TokenKind::Plus) {
                    UnaryOperator::Plus
                } else {
                    UnaryOperator::Minus
                };
                let expression = self.parse_expression(6, depth + 1)?;
                let span = Span {
                    line: token.span.line,
                    start: token.span.start,
                    end: expression.span.end,
                };
                self.node(
                    ExprKind::Unary {
                        operator,
                        expression: Box::new(expression),
                    },
                    span,
                )
            }
            TokenKind::LeftParen => {
                let expression = self.parse_expression(0, depth + 1)?;
                let close = self.advance().clone();
                if !matches!(close.kind, TokenKind::RightParen) {
                    return Err(FormulaError::new(
                        FormulaErrorKind::Value,
                        close.span,
                        "expected `)`",
                    ));
                }
                Ok(expression)
            }
            _ => Err(FormulaError::new(
                FormulaErrorKind::Value,
                token.span,
                "expected a formula expression",
            )),
        }
    }

    fn node(&mut self, kind: ExprKind, span: Span) -> Result<Expr, FormulaError> {
        self.node_count += 1;
        if self.node_count > MAX_EXPRESSION_NODES {
            return Err(FormulaError::new(
                FormulaErrorKind::Limit,
                span,
                format!("expression exceeds {MAX_EXPRESSION_NODES} syntax nodes"),
            ));
        }
        Ok(Expr { kind, span })
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.cursor]
    }

    fn advance(&mut self) -> &Token {
        let token = &self.tokens[self.cursor];
        if !matches!(token.kind, TokenKind::End) {
            self.cursor += 1;
        }
        token
    }
}

fn binary_operator(token: &TokenKind) -> Option<(BinaryOperator, u8)> {
    match token {
        TokenKind::Equal | TokenKind::EqualEqual => Some((BinaryOperator::Equal, 1)),
        TokenKind::NotEqual => Some((BinaryOperator::NotEqual, 1)),
        TokenKind::Less => Some((BinaryOperator::Less, 1)),
        TokenKind::LessEqual => Some((BinaryOperator::LessEqual, 1)),
        TokenKind::Greater => Some((BinaryOperator::Greater, 1)),
        TokenKind::GreaterEqual => Some((BinaryOperator::GreaterEqual, 1)),
        TokenKind::Plus => Some((BinaryOperator::Add, 3)),
        TokenKind::Minus => Some((BinaryOperator::Subtract, 3)),
        TokenKind::Star => Some((BinaryOperator::Multiply, 4)),
        TokenKind::Slash => Some((BinaryOperator::Divide, 4)),
        _ => None,
    }
}

struct Lexer<'a> {
    input: &'a str,
    line: usize,
    cursor: usize,
}

impl<'a> Lexer<'a> {
    fn new(input: &'a str, line: usize) -> Self {
        Self {
            input,
            line,
            cursor: 0,
        }
    }

    fn tokenize(mut self) -> Result<Vec<Token>, FormulaError> {
        let mut tokens = Vec::new();
        loop {
            self.skip_whitespace();
            let start = self.cursor;
            if start >= self.input.len() {
                tokens.push(Token {
                    kind: TokenKind::End,
                    span: self.span(start, start),
                });
                return Ok(tokens);
            }
            let byte = self.input.as_bytes()[start];
            let kind = match byte {
                b'+' => self.single(TokenKind::Plus),
                b'-' => self.single(TokenKind::Minus),
                b'*' => self.single(TokenKind::Star),
                b'/' => self.single(TokenKind::Slash),
                b':' => self.single(TokenKind::Colon),
                b',' => self.single(TokenKind::Comma),
                b'(' => self.single(TokenKind::LeftParen),
                b')' => self.single(TokenKind::RightParen),
                b'=' => {
                    self.cursor += 1;
                    if self.take_if(b'=') {
                        TokenKind::EqualEqual
                    } else {
                        TokenKind::Equal
                    }
                }
                b'!' => {
                    self.cursor += 1;
                    if self.take_if(b'=') {
                        TokenKind::NotEqual
                    } else {
                        return Err(self.error(start, "expected `=` after `!`"));
                    }
                }
                b'<' => {
                    self.cursor += 1;
                    if self.take_if(b'=') {
                        TokenKind::LessEqual
                    } else if self.take_if(b'>') {
                        TokenKind::NotEqual
                    } else {
                        TokenKind::Less
                    }
                }
                b'>' => {
                    self.cursor += 1;
                    if self.take_if(b'=') {
                        TokenKind::GreaterEqual
                    } else {
                        TokenKind::Greater
                    }
                }
                b'"' => TokenKind::String(self.string_literal()?),
                b'[' => self.named_column()?,
                b'0'..=b'9' | b'.' => TokenKind::Number(self.number()?),
                b'$' | b'A'..=b'Z' | b'a'..=b'z' | b'_' => self.word_or_cell()?,
                _ => {
                    return Err(self.error(
                        start,
                        format!(
                            "unexpected character `{}`",
                            self.input[start..].chars().next().unwrap_or('\0')
                        ),
                    ))
                }
            };
            tokens.push(Token {
                kind,
                span: self.span(start, self.cursor),
            });
        }
    }

    fn skip_whitespace(&mut self) {
        while self
            .input
            .as_bytes()
            .get(self.cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.cursor += 1;
        }
    }

    fn single(&mut self, kind: TokenKind) -> TokenKind {
        self.cursor += 1;
        kind
    }

    fn take_if(&mut self, byte: u8) -> bool {
        if self.input.as_bytes().get(self.cursor) == Some(&byte) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }

    fn string_literal(&mut self) -> Result<String, FormulaError> {
        let start = self.cursor;
        self.cursor += 1;
        let mut escaped = false;
        while let Some(&byte) = self.input.as_bytes().get(self.cursor) {
            self.cursor += 1;
            if byte == b'"' && !escaped {
                return serde_json::from_str(&self.input[start..self.cursor]).map_err(|error| {
                    self.error(start, format!("invalid string literal: {error}"))
                });
            }
            escaped = byte == b'\\' && !escaped;
            if byte != b'\\' {
                escaped = false;
            }
        }
        Err(self.error(start, "unterminated string literal"))
    }

    fn named_column(&mut self) -> Result<TokenKind, FormulaError> {
        let start = self.cursor;
        self.cursor += 1;
        let current_row = self.take_if(b'@');
        let name_start = self.cursor;
        while let Some(&byte) = self.input.as_bytes().get(self.cursor) {
            if byte == b']' {
                let name = self.input[name_start..self.cursor].to_owned();
                self.cursor += 1;
                if name.is_empty() {
                    return Err(self.error(start, "header reference must not be empty"));
                }
                return Ok(TokenKind::NamedColumn { name, current_row });
            }
            self.cursor += 1;
        }
        Err(self.error(start, "unterminated header reference"))
    }

    fn number(&mut self) -> Result<String, FormulaError> {
        let start = self.cursor;
        let mut digits = 0usize;
        while self
            .input
            .as_bytes()
            .get(self.cursor)
            .is_some_and(u8::is_ascii_digit)
        {
            self.cursor += 1;
            digits += 1;
        }
        if self.take_if(b'.') {
            while self
                .input
                .as_bytes()
                .get(self.cursor)
                .is_some_and(u8::is_ascii_digit)
            {
                self.cursor += 1;
                digits += 1;
            }
        }
        if digits == 0 {
            return Err(self.error(start, "invalid numeric literal"));
        }
        if self
            .input
            .as_bytes()
            .get(self.cursor)
            .is_some_and(|byte| matches!(byte, b'e' | b'E'))
        {
            self.cursor += 1;
            if self
                .input
                .as_bytes()
                .get(self.cursor)
                .is_some_and(|byte| matches!(byte, b'+' | b'-'))
            {
                self.cursor += 1;
            }
            let exponent_start = self.cursor;
            while self
                .input
                .as_bytes()
                .get(self.cursor)
                .is_some_and(u8::is_ascii_digit)
            {
                self.cursor += 1;
            }
            if exponent_start == self.cursor {
                return Err(self.error(start, "numeric exponent requires digits"));
            }
        }
        Ok(self.input[start..self.cursor].to_owned())
    }

    fn word_or_cell(&mut self) -> Result<TokenKind, FormulaError> {
        let start = self.cursor;
        let column_absolute = self.take_if(b'$');
        let letters_start = self.cursor;
        while self
            .input
            .as_bytes()
            .get(self.cursor)
            .is_some_and(u8::is_ascii_alphabetic)
        {
            self.cursor += 1;
        }
        let letters_end = self.cursor;
        let row_absolute = self.take_if(b'$');
        let digits_start = self.cursor;
        while self
            .input
            .as_bytes()
            .get(self.cursor)
            .is_some_and(u8::is_ascii_digit)
        {
            self.cursor += 1;
        }
        if letters_start < letters_end && digits_start < self.cursor {
            let column = parse_column(&self.input[letters_start..letters_end])
                .ok_or_else(|| self.error(start, "cell column is outside the supported range"))?;
            let row_number = self.input[digits_start..self.cursor]
                .parse::<usize>()
                .map_err(|_| self.error(start, "cell row is outside the supported range"))?;
            if row_number == 0 {
                return Err(self.error(start, "cell rows are one-based"));
            }
            return Ok(TokenKind::Cell(CellRef {
                column,
                row: row_number - 1,
            }));
        }
        if column_absolute || row_absolute {
            return Err(self.error(start, "invalid absolute cell reference"));
        }

        self.cursor = start;
        while self
            .input
            .as_bytes()
            .get(self.cursor)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        {
            self.cursor += 1;
        }
        Ok(TokenKind::Identifier(
            self.input[start..self.cursor].to_owned(),
        ))
    }

    fn span(&self, start: usize, end: usize) -> Span {
        let start = self
            .input
            .get(..start)
            .map_or(start, |prefix| prefix.chars().count());
        let end = self
            .input
            .get(..end)
            .map_or(start.saturating_add(1), |prefix| prefix.chars().count());
        Span {
            line: self.line,
            start,
            end,
        }
    }

    fn error(&self, start: usize, message: impl Into<String>) -> FormulaError {
        FormulaError::new(
            FormulaErrorKind::Value,
            self.span(start, self.cursor.max(start + 1)),
            message,
        )
    }
}

fn parse_column(letters: &str) -> Option<usize> {
    let mut value = 0usize;
    for byte in letters.bytes() {
        value = value.checked_mul(26)?;
        value = value.checked_add((byte.to_ascii_uppercase() - b'A' + 1) as usize)?;
    }
    value.checked_sub(1)
}

/// Table-size policy supplied by the Formula engine caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormulaEvaluationLimits {
    max_table_rows: usize,
    max_table_cells: usize,
}

impl FormulaEvaluationLimits {
    /// Create table limits from maximum row and total-cell counts.
    #[must_use]
    pub const fn new(max_table_rows: usize, max_table_cells: usize) -> Self {
        Self {
            max_table_rows,
            max_table_cells,
        }
    }

    /// Return the maximum output row count.
    #[must_use]
    pub const fn max_table_rows(self) -> usize {
        self.max_table_rows
    }

    /// Return the maximum total output cell count.
    #[must_use]
    pub const fn max_table_cells(self) -> usize {
        self.max_table_cells
    }
}

impl Default for FormulaEvaluationLimits {
    fn default() -> Self {
        Self::new(1_000, 10_000)
    }
}

/// Evaluate a parsed Formula program with the engine's default table limits.
pub fn evaluate_formula_program(
    program: &FormulaProgram,
    input: &DataTable,
    output_columns: &[String],
) -> Result<DataTable, FormulaError> {
    evaluate_formula_program_with_limits(
        program,
        input,
        output_columns,
        FormulaEvaluationLimits::default(),
    )
}

/// Evaluate a parsed Formula program with caller-supplied table limits.
pub fn evaluate_formula_program_with_limits(
    program: &FormulaProgram,
    input: &DataTable,
    output_columns: &[String],
    limits: FormulaEvaluationLimits,
) -> Result<DataTable, FormulaError> {
    let fallback_span = program.assignments.values().next().map_or(
        Span {
            line: 1,
            start: 0,
            end: 0,
        },
        |assignment| assignment.target_span,
    );
    if input.columns.len() > output_columns.len()
        || input
            .columns
            .iter()
            .zip(output_columns)
            .any(|(input, output)| input != output)
    {
        return Err(FormulaError::new(
            FormulaErrorKind::Ref,
            fallback_span,
            "output columns must begin with the input table columns in the same order",
        ));
    }
    let unique = output_columns.iter().collect::<BTreeSet<_>>();
    if unique.len() != output_columns.len() {
        return Err(FormulaError::new(
            FormulaErrorKind::Ref,
            fallback_span,
            "formula output columns must be unique",
        ));
    }

    let mut row_count = input.rows.len();
    for (target, assignment) in &program.assignments {
        if target.column >= output_columns.len() {
            return Err(FormulaError::new(
                FormulaErrorKind::Ref,
                assignment.target_span,
                format!("target `{target}` is outside the declared output columns"),
            )
            .at_target(*target));
        }
        if target.row < input.rows.len() && target.column < input.columns.len() {
            return Err(FormulaError::new(
                FormulaErrorKind::Ref,
                assignment.target_span,
                "formula targets cannot overwrite the input table",
            )
            .at_target(*target));
        }
        row_count = row_count.max(target.row + 1);
    }
    if row_count > limits.max_table_rows
        || row_count.saturating_mul(output_columns.len()) > limits.max_table_cells
    {
        return Err(FormulaError::new(
            FormulaErrorKind::Limit,
            fallback_span,
            "formula output exceeds the table row or cell limit",
        ));
    }

    let mut grid = vec![vec![DataScalar::Null; output_columns.len()]; row_count];
    for (row_index, row) in input.rows.iter().enumerate() {
        for (column_index, value) in row.iter().enumerate() {
            if column_index >= input.columns.len() {
                return Err(FormulaError::new(
                    FormulaErrorKind::Ref,
                    fallback_span,
                    format!("input row {} has more cells than columns", row_index + 1),
                ));
            }
            grid[row_index][column_index] = value.clone();
        }
    }

    let mut evaluator = Evaluator {
        program,
        columns: output_columns,
        input_rows: input.rows.len(),
        grid,
        states: BTreeMap::new(),
        steps: 0,
    };
    for target in program.assignments.keys().copied().collect::<Vec<_>>() {
        let value = evaluator.evaluate_cell(target)?;
        evaluator.grid[target.row][target.column] = value;
    }
    Ok(DataTable {
        columns: output_columns.to_vec(),
        rows: evaluator.grid,
    })
}

#[derive(Clone, Debug)]
enum EvaluationState {
    Visiting,
    Done(DataScalar),
}

#[derive(Clone, Debug)]
enum FormulaValue {
    Scalar(DataScalar),
    Range(Vec<CellRef>),
    Identifier(String),
}

struct Evaluator<'a> {
    program: &'a FormulaProgram,
    columns: &'a [String],
    input_rows: usize,
    grid: Vec<Vec<DataScalar>>,
    states: BTreeMap<CellRef, EvaluationState>,
    steps: usize,
}

impl Evaluator<'_> {
    fn evaluate_cell(&mut self, cell: CellRef) -> Result<DataScalar, FormulaError> {
        if cell.row >= self.grid.len() || cell.column >= self.columns.len() {
            return Err(FormulaError::new(
                FormulaErrorKind::Ref,
                self.fallback_span(),
                format!("cell `{cell}` is outside the output table"),
            ));
        }
        match self.states.get(&cell) {
            Some(EvaluationState::Done(value)) => return Ok(value.clone()),
            Some(EvaluationState::Visiting) => {
                let span = self
                    .program
                    .assignments
                    .get(&cell)
                    .map_or(self.fallback_span(), |assignment| assignment.target_span);
                return Err(FormulaError::new(
                    FormulaErrorKind::Cycle,
                    span,
                    format!("cyclic dependency includes `{cell}`"),
                )
                .at_target(cell));
            }
            None => {}
        }
        let Some(assignment) = self.program.assignments.get(&cell).cloned() else {
            return Ok(self.grid[cell.row][cell.column].clone());
        };
        self.states.insert(cell, EvaluationState::Visiting);
        let result = self
            .evaluate_expr(&assignment.expression, cell)
            .and_then(|value| self.require_scalar(value, assignment.expression.span))
            .map_err(|error| error.at_target(cell));
        match result {
            Ok(value) => {
                self.states
                    .insert(cell, EvaluationState::Done(value.clone()));
                self.grid[cell.row][cell.column] = value.clone();
                Ok(value)
            }
            Err(error) => {
                self.states.remove(&cell);
                Err(error)
            }
        }
    }

    fn evaluate_expr(
        &mut self,
        expression: &Expr,
        target: CellRef,
    ) -> Result<FormulaValue, FormulaError> {
        self.steps += 1;
        if self.steps > MAX_EVALUATION_STEPS {
            return Err(FormulaError::new(
                FormulaErrorKind::Limit,
                expression.span,
                format!("evaluation exceeds {MAX_EVALUATION_STEPS} steps"),
            ));
        }
        match &expression.kind {
            ExprKind::Scalar(value) => Ok(FormulaValue::Scalar(value.clone())),
            ExprKind::Cell(cell) => Ok(FormulaValue::Scalar(self.evaluate_cell(*cell)?)),
            ExprKind::Range(start, end) => {
                if start.row > end.row || start.column > end.column {
                    return Err(FormulaError::new(
                        FormulaErrorKind::Ref,
                        expression.span,
                        "range start must be above and to the left of its end",
                    ));
                }
                if end.row >= self.grid.len() || end.column >= self.columns.len() {
                    return Err(FormulaError::new(
                        FormulaErrorKind::Ref,
                        expression.span,
                        format!("range `{start}:{end}` is outside the output table"),
                    ));
                }
                let mut cells = Vec::new();
                for row in start.row..=end.row {
                    for column in start.column..=end.column {
                        cells.push(CellRef { row, column });
                    }
                }
                Ok(FormulaValue::Range(cells))
            }
            ExprKind::NamedColumn { name, current_row } => {
                let column = self.column_by_name(name, expression.span)?;
                if *current_row {
                    Ok(FormulaValue::Scalar(self.evaluate_cell(CellRef {
                        row: target.row,
                        column,
                    })?))
                } else {
                    Ok(FormulaValue::Range(
                        (0..self.input_rows)
                            .map(|row| CellRef { row, column })
                            .collect(),
                    ))
                }
            }
            ExprKind::Identifier(name) => Ok(FormulaValue::Identifier(name.clone())),
            ExprKind::Unary {
                operator,
                expression: operand,
            } => {
                let value = self.evaluate_expr(operand, target)?;
                let scalar = self.require_scalar(value, operand.span)?;
                Ok(FormulaValue::Scalar(evaluate_unary(
                    *operator,
                    scalar,
                    expression.span,
                )?))
            }
            ExprKind::Binary {
                operator,
                left,
                right,
            } => {
                let left_value = self.evaluate_expr(left, target)?;
                let left_value = self.require_scalar(left_value, left.span)?;
                let right_value = self.evaluate_expr(right, target)?;
                let right_value = self.require_scalar(right_value, right.span)?;
                Ok(FormulaValue::Scalar(evaluate_binary(
                    *operator,
                    left_value,
                    right_value,
                    expression.span,
                )?))
            }
            ExprKind::Call { name, arguments } => {
                self.evaluate_call(name, arguments, expression.span, target)
            }
        }
    }

    fn evaluate_call(
        &mut self,
        name: &str,
        arguments: &[Expr],
        span: Span,
        target: CellRef,
    ) -> Result<FormulaValue, FormulaError> {
        let upper = name.to_ascii_uppercase();
        if upper == "IF" {
            require_argument_count(&upper, arguments, 3, span)?;
            let condition = self.evaluate_expr(&arguments[0], target)?;
            let condition = self.require_boolean(condition, arguments[0].span)?;
            return self.evaluate_expr(
                if condition {
                    &arguments[1]
                } else {
                    &arguments[2]
                },
                target,
            );
        }
        if upper == "HEADER" {
            require_argument_count(&upper, arguments, 1, span)?;
            let ExprKind::Identifier(column) = &arguments[0].kind else {
                return Err(FormulaError::new(
                    FormulaErrorKind::Value,
                    arguments[0].span,
                    "HEADER expects a column label such as `A`",
                ));
            };
            let column = parse_column(column).ok_or_else(|| {
                FormulaError::new(
                    FormulaErrorKind::Ref,
                    arguments[0].span,
                    "HEADER column label is invalid",
                )
            })?;
            let header = self.columns.get(column).ok_or_else(|| {
                FormulaError::new(
                    FormulaErrorKind::Ref,
                    arguments[0].span,
                    "HEADER column is outside the output table",
                )
            })?;
            return Ok(FormulaValue::Scalar(DataScalar::String(header.clone())));
        }

        let mut values = Vec::with_capacity(arguments.len());
        for argument in arguments {
            values.push((self.evaluate_expr(argument, target)?, argument.span));
        }
        let scalar = match upper.as_str() {
            "SUM" => self.aggregate_numbers(&values, span, Aggregate::Sum)?,
            "AVERAGE" => self.aggregate_numbers(&values, span, Aggregate::Average)?,
            "MIN" => self.aggregate_numbers(&values, span, Aggregate::Min)?,
            "MAX" => self.aggregate_numbers(&values, span, Aggregate::Max)?,
            "COUNT" => self.count_numbers(&values, span)?,
            "AND" => self.logical_values(&values, span, true)?,
            "OR" => self.logical_values(&values, span, false)?,
            "NOT" => {
                require_value_count(&upper, &values, 1, span)?;
                DataScalar::Boolean(!self.require_boolean(values[0].0.clone(), values[0].1)?)
            }
            "ROUND" => self.round(&values, span)?,
            "ABS" => self.abs(&values, span)?,
            "CONCAT" => self.concat(&values, span)?,
            "LEN" => self.len(&values, span)?,
            "ISNULL" => {
                require_value_count(&upper, &values, 1, span)?;
                let value = self.require_scalar(values[0].0.clone(), values[0].1)?;
                DataScalar::Boolean(matches!(value, DataScalar::Null))
            }
            _ => {
                return Err(FormulaError::new(
                    FormulaErrorKind::Name,
                    span,
                    format!("unknown function `{name}`"),
                ))
            }
        };
        Ok(FormulaValue::Scalar(scalar))
    }

    fn flattened_scalars(
        &mut self,
        values: &[(FormulaValue, Span)],
    ) -> Result<Vec<(DataScalar, Span)>, FormulaError> {
        let mut flattened = Vec::new();
        for (value, span) in values {
            match value {
                FormulaValue::Scalar(value) => flattened.push((value.clone(), *span)),
                FormulaValue::Range(cells) => {
                    for cell in cells {
                        flattened.push((self.evaluate_cell(*cell)?, *span));
                    }
                }
                FormulaValue::Identifier(name) => {
                    return Err(FormulaError::new(
                        FormulaErrorKind::Name,
                        *span,
                        format!("unknown name `{name}`"),
                    ))
                }
            }
        }
        Ok(flattened)
    }

    fn aggregate_numbers(
        &mut self,
        values: &[(FormulaValue, Span)],
        span: Span,
        aggregate: Aggregate,
    ) -> Result<DataScalar, FormulaError> {
        if values.is_empty() {
            return Err(FormulaError::new(
                FormulaErrorKind::Value,
                span,
                "aggregate function requires at least one argument",
            ));
        }
        let flattened = self.flattened_scalars(values)?;
        let mut numbers = Vec::new();
        for (value, value_span) in flattened {
            match value {
                DataScalar::Null => {}
                DataScalar::Integer(value) => numbers.push(Number::Integer(value)),
                DataScalar::Real(value) => numbers.push(Number::Real(value)),
                DataScalar::Boolean(_) | DataScalar::String(_) => {
                    return Err(FormulaError::new(
                        FormulaErrorKind::Value,
                        value_span,
                        "aggregate arguments must contain only numbers or NULL",
                    ))
                }
            }
        }
        aggregate_numbers(numbers, aggregate, span)
    }

    fn count_numbers(
        &mut self,
        values: &[(FormulaValue, Span)],
        span: Span,
    ) -> Result<DataScalar, FormulaError> {
        if values.is_empty() {
            return Err(FormulaError::new(
                FormulaErrorKind::Value,
                span,
                "COUNT requires at least one argument",
            ));
        }
        let count = self
            .flattened_scalars(values)?
            .into_iter()
            .filter(|(value, _)| matches!(value, DataScalar::Integer(_) | DataScalar::Real(_)))
            .count();
        Ok(DataScalar::Integer(count as i64))
    }

    fn logical_values(
        &mut self,
        values: &[(FormulaValue, Span)],
        span: Span,
        and: bool,
    ) -> Result<DataScalar, FormulaError> {
        if values.is_empty() {
            return Err(FormulaError::new(
                FormulaErrorKind::Value,
                span,
                "logical function requires at least one argument",
            ));
        }
        let mut result = and;
        for (value, value_span) in self.flattened_scalars(values)? {
            let DataScalar::Boolean(value) = value else {
                return Err(FormulaError::new(
                    FormulaErrorKind::Value,
                    value_span,
                    "logical arguments must be boolean",
                ));
            };
            if and {
                result &= value;
            } else {
                result |= value;
            }
        }
        Ok(DataScalar::Boolean(result))
    }

    fn round(
        &mut self,
        values: &[(FormulaValue, Span)],
        span: Span,
    ) -> Result<DataScalar, FormulaError> {
        if !(1..=2).contains(&values.len()) {
            return Err(FormulaError::new(
                FormulaErrorKind::Value,
                span,
                "ROUND expects one or two arguments",
            ));
        }
        let number = self.require_scalar(values[0].0.clone(), values[0].1)?;
        let digits = if values.len() == 2 {
            match self.require_scalar(values[1].0.clone(), values[1].1)? {
                DataScalar::Integer(value) if (-15..=15).contains(&value) => value as i32,
                _ => {
                    return Err(FormulaError::new(
                        FormulaErrorKind::Value,
                        values[1].1,
                        "ROUND digits must be an integer from -15 to 15",
                    ))
                }
            }
        } else {
            0
        };
        let value = numeric_as_f64(number, values[0].1)?;
        let factor = 10_f64.powi(digits);
        finite_real((value * factor).round() / factor, span)
    }

    fn abs(
        &mut self,
        values: &[(FormulaValue, Span)],
        span: Span,
    ) -> Result<DataScalar, FormulaError> {
        require_value_count("ABS", values, 1, span)?;
        match self.require_scalar(values[0].0.clone(), values[0].1)? {
            DataScalar::Integer(value) => {
                value.checked_abs().map(DataScalar::Integer).ok_or_else(|| {
                    FormulaError::new(FormulaErrorKind::Value, span, "ABS integer overflow")
                })
            }
            DataScalar::Real(value) => finite_real(value.abs(), span),
            _ => Err(FormulaError::new(
                FormulaErrorKind::Value,
                values[0].1,
                "ABS expects a number",
            )),
        }
    }

    fn concat(
        &mut self,
        values: &[(FormulaValue, Span)],
        span: Span,
    ) -> Result<DataScalar, FormulaError> {
        if values.is_empty() {
            return Err(FormulaError::new(
                FormulaErrorKind::Value,
                span,
                "CONCAT requires at least one argument",
            ));
        }
        let mut output = String::new();
        for (value, _) in self.flattened_scalars(values)? {
            match value {
                DataScalar::Null => {}
                DataScalar::Boolean(value) => output.push_str(if value { "TRUE" } else { "FALSE" }),
                DataScalar::Integer(value) => output.push_str(&value.to_string()),
                DataScalar::Real(value) => output.push_str(&value.to_string()),
                DataScalar::String(value) => output.push_str(&value),
            }
            if output.len() > MAX_FORMULA_TEXT_BYTES {
                return Err(FormulaError::new(
                    FormulaErrorKind::Limit,
                    span,
                    format!("CONCAT result exceeds {MAX_FORMULA_TEXT_BYTES} bytes"),
                ));
            }
        }
        Ok(DataScalar::String(output))
    }

    fn len(
        &mut self,
        values: &[(FormulaValue, Span)],
        span: Span,
    ) -> Result<DataScalar, FormulaError> {
        require_value_count("LEN", values, 1, span)?;
        match self.require_scalar(values[0].0.clone(), values[0].1)? {
            DataScalar::String(value) => Ok(DataScalar::Integer(value.chars().count() as i64)),
            _ => Err(FormulaError::new(
                FormulaErrorKind::Value,
                values[0].1,
                "LEN expects a string",
            )),
        }
    }

    fn require_scalar(&self, value: FormulaValue, span: Span) -> Result<DataScalar, FormulaError> {
        match value {
            FormulaValue::Scalar(value) => Ok(value),
            FormulaValue::Range(_) => Err(FormulaError::new(
                FormulaErrorKind::Value,
                span,
                "a range cannot be used as a scalar value",
            )),
            FormulaValue::Identifier(name) => Err(FormulaError::new(
                FormulaErrorKind::Name,
                span,
                format!("unknown name `{name}`"),
            )),
        }
    }

    fn require_boolean(&self, value: FormulaValue, span: Span) -> Result<bool, FormulaError> {
        match self.require_scalar(value, span)? {
            DataScalar::Boolean(value) => Ok(value),
            _ => Err(FormulaError::new(
                FormulaErrorKind::Value,
                span,
                "condition must be boolean",
            )),
        }
    }

    fn column_by_name(&self, name: &str, span: Span) -> Result<usize, FormulaError> {
        let matches = self
            .columns
            .iter()
            .enumerate()
            .filter_map(|(index, column)| (column == name).then_some(index))
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [index] => Ok(*index),
            [] => Err(FormulaError::new(
                FormulaErrorKind::Ref,
                span,
                format!("header `{name}` is not defined"),
            )),
            _ => Err(FormulaError::new(
                FormulaErrorKind::Ref,
                span,
                format!("header `{name}` is ambiguous"),
            )),
        }
    }

    fn fallback_span(&self) -> Span {
        self.program.assignments.values().next().map_or(
            Span {
                line: 1,
                start: 0,
                end: 0,
            },
            |assignment| assignment.target_span,
        )
    }
}

fn require_argument_count(
    name: &str,
    arguments: &[Expr],
    expected: usize,
    span: Span,
) -> Result<(), FormulaError> {
    if arguments.len() == expected {
        Ok(())
    } else {
        Err(FormulaError::new(
            FormulaErrorKind::Value,
            span,
            format!("{name} expects {expected} arguments"),
        ))
    }
}

fn require_value_count(
    name: &str,
    values: &[(FormulaValue, Span)],
    expected: usize,
    span: Span,
) -> Result<(), FormulaError> {
    if values.len() == expected {
        Ok(())
    } else {
        Err(FormulaError::new(
            FormulaErrorKind::Value,
            span,
            format!("{name} expects {expected} arguments"),
        ))
    }
}

#[derive(Clone, Copy)]
enum Number {
    Integer(i64),
    Real(f64),
}

#[derive(Clone, Copy)]
enum Aggregate {
    Sum,
    Average,
    Min,
    Max,
}

fn aggregate_numbers(
    numbers: Vec<Number>,
    aggregate: Aggregate,
    span: Span,
) -> Result<DataScalar, FormulaError> {
    if numbers.is_empty() {
        return match aggregate {
            Aggregate::Average => Err(FormulaError::new(
                FormulaErrorKind::DivZero,
                span,
                "AVERAGE has no numeric values",
            )),
            Aggregate::Sum | Aggregate::Min | Aggregate::Max => Ok(DataScalar::Integer(0)),
        };
    }
    let has_real = numbers
        .iter()
        .any(|number| matches!(number, Number::Real(_)));
    match aggregate {
        Aggregate::Sum if !has_real => {
            let mut total = 0i64;
            for number in numbers {
                let Number::Integer(value) = number else {
                    unreachable!()
                };
                total = total.checked_add(value).ok_or_else(|| {
                    FormulaError::new(FormulaErrorKind::Value, span, "SUM integer overflow")
                })?;
            }
            Ok(DataScalar::Integer(total))
        }
        Aggregate::Min if !has_real => Ok(DataScalar::Integer(
            numbers
                .into_iter()
                .map(|number| match number {
                    Number::Integer(value) => value,
                    Number::Real(_) => unreachable!(),
                })
                .min()
                .expect("non-empty numbers"),
        )),
        Aggregate::Max if !has_real => Ok(DataScalar::Integer(
            numbers
                .into_iter()
                .map(|number| match number {
                    Number::Integer(value) => value,
                    Number::Real(_) => unreachable!(),
                })
                .max()
                .expect("non-empty numbers"),
        )),
        aggregate => {
            let values = numbers
                .into_iter()
                .map(|number| match number {
                    Number::Integer(value) => value as f64,
                    Number::Real(value) => value,
                })
                .collect::<Vec<_>>();
            let value = match aggregate {
                Aggregate::Sum => values.iter().sum(),
                Aggregate::Average => values.iter().sum::<f64>() / values.len() as f64,
                Aggregate::Min => values
                    .into_iter()
                    .reduce(f64::min)
                    .expect("non-empty values"),
                Aggregate::Max => values
                    .into_iter()
                    .reduce(f64::max)
                    .expect("non-empty values"),
            };
            finite_real(value, span)
        }
    }
}

fn evaluate_unary(
    operator: UnaryOperator,
    value: DataScalar,
    span: Span,
) -> Result<DataScalar, FormulaError> {
    match (operator, value) {
        (UnaryOperator::Plus, value @ (DataScalar::Integer(_) | DataScalar::Real(_))) => Ok(value),
        (UnaryOperator::Minus, DataScalar::Integer(value)) => value
            .checked_neg()
            .map(DataScalar::Integer)
            .ok_or_else(|| FormulaError::new(FormulaErrorKind::Value, span, "integer overflow")),
        (UnaryOperator::Minus, DataScalar::Real(value)) => finite_real(-value, span),
        _ => Err(FormulaError::new(
            FormulaErrorKind::Value,
            span,
            "unary arithmetic expects a number",
        )),
    }
}

fn evaluate_binary(
    operator: BinaryOperator,
    left: DataScalar,
    right: DataScalar,
    span: Span,
) -> Result<DataScalar, FormulaError> {
    match operator {
        BinaryOperator::Add | BinaryOperator::Subtract | BinaryOperator::Multiply => {
            arithmetic(operator, left, right, span)
        }
        BinaryOperator::Divide => {
            let left = numeric_as_f64(left, span)?;
            let right = numeric_as_f64(right, span)?;
            if right == 0.0 {
                return Err(FormulaError::new(
                    FormulaErrorKind::DivZero,
                    span,
                    "division by zero",
                ));
            }
            finite_real(left / right, span)
        }
        BinaryOperator::Equal | BinaryOperator::NotEqual => {
            let equal = scalar_equal(&left, &right);
            Ok(DataScalar::Boolean(
                if matches!(operator, BinaryOperator::Equal) {
                    equal
                } else {
                    !equal
                },
            ))
        }
        BinaryOperator::Less
        | BinaryOperator::LessEqual
        | BinaryOperator::Greater
        | BinaryOperator::GreaterEqual => {
            let ordering = scalar_order(&left, &right, span)?;
            let value = match operator {
                BinaryOperator::Less => ordering == Ordering::Less,
                BinaryOperator::LessEqual => ordering != Ordering::Greater,
                BinaryOperator::Greater => ordering == Ordering::Greater,
                BinaryOperator::GreaterEqual => ordering != Ordering::Less,
                _ => unreachable!(),
            };
            Ok(DataScalar::Boolean(value))
        }
    }
}

fn arithmetic(
    operator: BinaryOperator,
    left: DataScalar,
    right: DataScalar,
    span: Span,
) -> Result<DataScalar, FormulaError> {
    match (left, right) {
        (DataScalar::Integer(left), DataScalar::Integer(right)) => {
            let value = match operator {
                BinaryOperator::Add => left.checked_add(right),
                BinaryOperator::Subtract => left.checked_sub(right),
                BinaryOperator::Multiply => left.checked_mul(right),
                _ => unreachable!(),
            };
            value.map(DataScalar::Integer).ok_or_else(|| {
                FormulaError::new(FormulaErrorKind::Value, span, "integer arithmetic overflow")
            })
        }
        (
            left @ (DataScalar::Integer(_) | DataScalar::Real(_)),
            right @ (DataScalar::Integer(_) | DataScalar::Real(_)),
        ) => {
            let left = numeric_as_f64(left, span)?;
            let right = numeric_as_f64(right, span)?;
            let value = match operator {
                BinaryOperator::Add => left + right,
                BinaryOperator::Subtract => left - right,
                BinaryOperator::Multiply => left * right,
                _ => unreachable!(),
            };
            finite_real(value, span)
        }
        _ => Err(FormulaError::new(
            FormulaErrorKind::Value,
            span,
            "arithmetic operands must be numbers",
        )),
    }
}

fn numeric_as_f64(value: DataScalar, span: Span) -> Result<f64, FormulaError> {
    match value {
        DataScalar::Integer(value) => Ok(value as f64),
        DataScalar::Real(value) => Ok(value),
        _ => Err(FormulaError::new(
            FormulaErrorKind::Value,
            span,
            "expected a number",
        )),
    }
}

fn finite_real(value: f64, span: Span) -> Result<DataScalar, FormulaError> {
    if value.is_finite() {
        Ok(DataScalar::Real(value))
    } else {
        Err(FormulaError::new(
            FormulaErrorKind::Value,
            span,
            "calculation produced a non-finite real",
        ))
    }
}

fn scalar_equal(left: &DataScalar, right: &DataScalar) -> bool {
    match (left, right) {
        (DataScalar::Null, DataScalar::Null) => true,
        (DataScalar::Boolean(left), DataScalar::Boolean(right)) => left == right,
        (DataScalar::Integer(left), DataScalar::Integer(right)) => left == right,
        (DataScalar::Real(left), DataScalar::Real(right)) => left == right,
        (DataScalar::Integer(left), DataScalar::Real(right)) => *left as f64 == *right,
        (DataScalar::Real(left), DataScalar::Integer(right)) => *left == *right as f64,
        (DataScalar::String(left), DataScalar::String(right)) => left == right,
        _ => false,
    }
}

fn scalar_order(
    left: &DataScalar,
    right: &DataScalar,
    span: Span,
) -> Result<Ordering, FormulaError> {
    match (left, right) {
        (DataScalar::Integer(left), DataScalar::Integer(right)) => Ok(left.cmp(right)),
        (DataScalar::Integer(left), DataScalar::Real(right)) => {
            (*left as f64).partial_cmp(right).ok_or_else(|| {
                FormulaError::new(FormulaErrorKind::Value, span, "values cannot be compared")
            })
        }
        (DataScalar::Real(left), DataScalar::Integer(right)) => {
            left.partial_cmp(&(*right as f64)).ok_or_else(|| {
                FormulaError::new(FormulaErrorKind::Value, span, "values cannot be compared")
            })
        }
        (DataScalar::Real(left), DataScalar::Real(right)) => {
            left.partial_cmp(right).ok_or_else(|| {
                FormulaError::new(FormulaErrorKind::Value, span, "values cannot be compared")
            })
        }
        (DataScalar::String(left), DataScalar::String(right)) => Ok(left.cmp(right)),
        (DataScalar::Boolean(left), DataScalar::Boolean(right)) => Ok(left.cmp(right)),
        _ => Err(FormulaError::new(
            FormulaErrorKind::Value,
            span,
            "comparison operands must have compatible types",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input_table() -> DataTable {
        DataTable {
            columns: vec!["item".to_owned(), "amount".to_owned()],
            rows: vec![
                vec![
                    DataScalar::String("books".to_owned()),
                    DataScalar::Integer(10),
                ],
                vec![
                    DataScalar::String("games".to_owned()),
                    DataScalar::Integer(20),
                ],
                vec![DataScalar::String("music".to_owned()), DataScalar::Null],
            ],
        }
    }

    fn evaluate(program: &str, columns: &[&str]) -> Result<DataTable, FormulaError> {
        let program = parse_formula_program(program)?;
        evaluate_formula_program(
            &program,
            &input_table(),
            &columns
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn evaluates_references_ranges_headers_and_dependencies() {
        let table = evaluate(
            r#"
                // derived values
                C1 = A1
                C2 = SUM(B1:B3)
                C3 = SUM([amount])
                C4 = CONCAT(HEADER(A), ":", C1)
                C5 = C2 + C3
            "#,
            &["item", "amount", "result"],
        )
        .expect("formula table");
        assert_eq!(
            table
                .rows
                .iter()
                .map(|row| row[2].clone())
                .collect::<Vec<_>>(),
            vec![
                DataScalar::String("books".to_owned()),
                DataScalar::Integer(30),
                DataScalar::Integer(30),
                DataScalar::String("item:books".to_owned()),
                DataScalar::Integer(60),
            ]
        );
    }

    #[test]
    fn evaluates_required_functions_and_operators() {
        let table = evaluate(
            r#"
                C1 = AVERAGE(B1:B2)
                C2 = MIN(B1:B2)
                C3 = MAX(B1:B2)
                C4 = COUNT(B1:B3)
                C5 = IF(AND(B1 < B2, NOT(FALSE)), ROUND(1.234, 2), 0)
                C6 = OR(FALSE, TRUE)
                C7 = ABS(-3)
                C8 = LEN(CONCAT("a", "β"))
                C9 = ISNULL(B3)
                C10 = (B2 / B1) + (B2 - B1) * 2
            "#,
            &["item", "amount", "result"],
        )
        .expect("formula table");
        let result = table
            .rows
            .iter()
            .map(|row| row[2].clone())
            .collect::<Vec<_>>();
        assert_eq!(result[0], DataScalar::Real(15.0));
        assert_eq!(result[1], DataScalar::Integer(10));
        assert_eq!(result[2], DataScalar::Integer(20));
        assert_eq!(result[3], DataScalar::Integer(2));
        assert_eq!(result[4], DataScalar::Real(1.23));
        assert_eq!(result[5], DataScalar::Boolean(true));
        assert_eq!(result[6], DataScalar::Integer(3));
        assert_eq!(result[7], DataScalar::Integer(2));
        assert_eq!(result[8], DataScalar::Boolean(true));
        assert_eq!(result[9], DataScalar::Real(22.0));
    }

    #[test]
    fn supports_absolute_and_current_row_references() {
        let table = evaluate(
            "C1 = =$B$1\nC2 = [@amount] * 2\n",
            &["item", "amount", "result"],
        )
        .expect("formula table");
        assert_eq!(table.rows[0][2], DataScalar::Integer(10));
        assert_eq!(table.rows[1][2], DataScalar::Integer(40));
    }

    #[test]
    fn rejects_input_overwrites_and_cycles_with_locations() {
        let error = evaluate("A1 = 1", &["item", "amount"]).expect_err("input overwrite");
        assert!(error
            .to_string()
            .contains("cell `A1`: #REF! at line 1, column 1"));

        let error = evaluate("C1 = C2\nC2 = C1", &["item", "amount", "result"]).expect_err("cycle");
        assert!(error.to_string().contains("#CYCLE!"));
        assert!(error.to_string().contains("line"));
    }

    #[test]
    fn reports_typed_formula_failures() {
        let error =
            evaluate("C1 = 1 / 0", &["item", "amount", "result"]).expect_err("division by zero");
        assert!(error.to_string().contains("#DIV/0!"));

        let error = evaluate("C1 = MISSING(1)", &["item", "amount", "result"])
            .expect_err("unknown function");
        assert!(error.to_string().contains("#NAME?"));

        let error =
            evaluate("C1 = Z99", &["item", "amount", "result"]).expect_err("invalid reference");
        assert!(error.to_string().contains("#REF!"));

        let error =
            evaluate("C1 = SUM(A1:A2)", &["item", "amount", "result"]).expect_err("string sum");
        assert!(error.to_string().contains("#VALUE!"));

        let error = parse_formula_program("C1 = CONCAT(\"β\", )")
            .expect_err("syntax error after multibyte text");
        assert!(error.to_string().contains("line 1, column 18"));
    }

    #[test]
    fn preserves_strings_around_comments_and_enforces_program_limits() {
        let table = evaluate(
            "C1 = CONCAT(\"https://example.test\", \"//value\") // trailing\nC2 = NULL",
            &["item", "amount", "result"],
        )
        .expect("comment-aware program");
        assert_eq!(
            table.rows[0][2],
            DataScalar::String("https://example.test//value".to_owned())
        );
        assert_eq!(table.rows[1][2], DataScalar::Null);

        let oversized = " ".repeat(MAX_FORMULA_PROGRAM_BYTES + 1);
        let error = parse_formula_program(&oversized).expect_err("program byte limit");
        assert!(error.to_string().contains("#LIMIT!"));

        let error =
            evaluate("C1001 = 1", &["item", "amount", "result"]).expect_err("table row limit");
        assert!(error.to_string().contains("#LIMIT!"));
    }
}
