/*
 * semgrep-csharp
 *
 * Extend the original tree-sitter C# grammar with semgrep-specific constructs
 * used to represent semgrep patterns.
 *
 * The language is renamed from c-sharp to csharp to match language name
 * conventions in ocaml-tree-sitter and semgrep.
 */

// The base grammar is an ES module: require returns its namespace object.
const standard_grammar = require('tree-sitter-c-sharp/grammar').default;

// The precedences of the base grammar that the rules below use.
const PREC = {
  DOT: 18,
  UNARY: 17,
  CAST: 17,
  MULT: 13,
  ADD: 12,
  SHIFT: 11,
};

// The dynamic precedence of a binary expression. An operator that is also a
// prefix operator gets a dynamic precedence higher than the dynamic precedence
// 1 of a cast: by the C# specification of cast expressions, `(a) - b` is a
// subtraction, and `(int) -b` is a cast because `int` is not an expression.
function binaryDynamicPrecedence(operator) {
  return ['+', '-', '*', '&', '^'].includes(operator) ? 2 : 0;
}

// The operator of an alternative of the base grammar's binary_expression.
function binaryOperator(rule) {
  return rule.content.members.find(member =>
    member.type === 'FIELD' && member.name === 'operator').content.value;
}

// Every pre-processing directive is an extra, like a comment, that ends at the
// end of its line or of the file. Conditional-compilation directives are extras
// too, so the code of every branch is parsed, including a branch that holds part
// of a construct. These helpers remove the base grammar's structured preproc_if
// alternatives.
function isPreprocIf(rule) {
  const name = rule.type === 'ALIAS' ? rule.content.name : rule.name;
  return (rule.type === 'ALIAS' || rule.type === 'SYMBOL') && name.startsWith('preproc_if');
}

function withoutPreprocIf(rule) {
  switch (rule.type) {
    case 'CHOICE':
      return {...rule, members: rule.members.filter(m => !isPreprocIf(m)).map(withoutPreprocIf)};
    case 'SEQ':
      return {...rule, members: rule.members.map(withoutPreprocIf)};
    case 'PREC': case 'PREC_LEFT': case 'PREC_RIGHT': case 'PREC_DYNAMIC':
    case 'REPEAT': case 'REPEAT1': case 'FIELD': case 'ALIAS':
      return {...rule, content: withoutPreprocIf(rule.content)};
    default:
      return rule;
  }
}

module.exports = grammar(standard_grammar, {
  /*
    We can't rename the grammar to 'csharp' because it relies on a custom
    lexer ('scanner.c') which comes with the inherited grammar and provides
    a function 'tree_sitter_c_sharp_external_scanner_create'.
    The code generator ('tree-sitter generate') however expects this function
    name to match the grammar name, so if we rename it here to 'csharp',
    it will generate glue code that calls
    'tree_sitter_csharp_external_scanner_create'
    while only 'tree_sitter_c_sharp_external_scanner_create' is available.
  */
  name: 'c_sharp',

  conflicts: ($, previous) => [
    ...previous,
    [$.expression, $.parameter],
    [$.binary_expression, $._constant_pattern_binary_expression],
    [$.constant_pattern, $.lvalue_expression, $.conditional_access_expression],
    [$.constant_pattern, $.non_lvalue_expression, $.conditional_access_expression],
    [$.constant_pattern, $._expression_statement_expression, $.conditional_access_expression],
    [$._name, $.constant_pattern, $.lvalue_expression, $.conditional_access_expression],
    [$.non_lvalue_expression, $.lvalue_expression, $.conditional_access_expression],
    [$._expression_statement_expression, $.conditional_access_expression],
    [$._name, $.lvalue_expression, $.conditional_access_expression],
    [$.non_lvalue_expression, $.conditional_access_expression],
    [$.lvalue_expression, $.conditional_access_expression],
  ],

  extras: ($, previous) => [
    ...previous.filter(rule => !(rule.type === 'SYMBOL' && rule.name.startsWith('preproc_'))),
    $.pp_directive,
  ],

  rules: {

    // Entry point
    compilation_unit: ($, previous) => {
      return choice(
        previous,
        $.semgrep_expression
      );
    },

    // A directive line, including the #: lines of file-based programs. The #!
    // line is the base grammar's shebang_directive.
    pp_directive: _ => token(seq(/#[ \t]*[a-z:]/, /[^\r\n]*/)),

    _top_level_item_no_statement: ($, previous) => withoutPreprocIf(previous),
    _attribute_list: ($, previous) => withoutPreprocIf(previous),
    enum_member_declaration_list: ($, previous) => withoutPreprocIf(previous),
    statement: ($, previous) => withoutPreprocIf(previous),
    non_lvalue_expression: ($, previous) => withoutPreprocIf(previous),

    // The identifier characters of the C# specification: unlike XID_Continue,
    // an identifier part includes every formatting character (Cf).
    _identifier_token: _ => token(seq(
      optional('@'),
      /([\p{L}\p{Nl}_]|\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8})([\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]|\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8})*/,
    )),

    // The C# 13 anti-constraint 'allows ref struct'.
    type_parameter_constraint: ($, previous) => choice(
      previous,
      seq('allows', 'ref', 'struct'),
    ),

    // A backslash followed by any character, as the compiler reports an
    // invalid escape sequence and reads the rest of the literal.
    escape_sequence: _ => token(choice(
      /\\x[0-9a-fA-F]{1,4}/,
      /\\u[0-9a-fA-F]{4}/,
      /\\U[0-9a-fA-F]{8}/,
      /\\(.|\n)/,
    )),

    // `(a) - b` is a subtraction rather than a cast of `-b`.
    binary_expression: ($, previous) => choice(
      ...previous.members.map(rule => {
        const precedence = binaryDynamicPrecedence(binaryOperator(rule));
        return precedence === 0 ? rule : prec.dynamic(precedence, rule);
      }),
    ),

    // The operand of `*` is any expression: `*(p + 1)` and `*(int*)b` are
    // dereferences, and `*p++` is `*(p++)`.
    _pointer_indirection_expression: $ => prec.right(PREC.UNARY, seq(
      '*',
      $.expression,
    )),

    // An assignment operator ends the operand of `*`: `*p = v` assigns to `*p`.
    assignment_expression: ($, previous) => prec(-1, previous),

    // The operand of a constant pattern binds tighter than `is`, so a binary
    // expression in it has a shift, additive or multiplicative operator:
    // `x is A && y` is a conjunction.
    constant_pattern: ($, previous) => choice(
      ...previous.members.filter(rule =>
        !(rule.type === 'SYMBOL' && rule.name === 'binary_expression')),
      alias($._constant_pattern_binary_expression, $.binary_expression),
    ),

    // The dynamic precedences below decide the same reading of `is` in a
    // pattern and in a target. In `x is A`, the name A is a constant pattern
    // rather than the type of a type test.
    is_expression: ($, previous) => prec.dynamic(-1, previous),

    // In `x is int[]`, the type is the type of a type test rather than a
    // type pattern.
    type_pattern: ($, previous) => prec.dynamic(-2, previous),

    // In `x is var (a, b)`, the pattern binds a and b.
    var_pattern: ($, previous) => prec.dynamic(1, previous),

    // In `x is 1 + 2`, the operator binds tighter than `is`: the dynamic
    // precedence is one more than the binary expression's.
    _constant_pattern_binary_expression: $ => choice(
      ...[
        ['>>', PREC.SHIFT],
        ['>>>', PREC.SHIFT],
        ['<<', PREC.SHIFT],
        ['+', PREC.ADD],
        ['-', PREC.ADD],
        ['*', PREC.MULT],
        ['/', PREC.MULT],
        ['%', PREC.MULT],
      ].map(([operator, precedence]) =>
        prec.dynamic(binaryDynamicPrecedence(operator) + 1, prec.left(precedence, seq(
          field('left', $.expression),
          field('operator', operator),
          field('right', $.expression),
        ))),
      ),
    ),

    // The receiver of `?.` and `?[` is a primary expression, as in the C#
    // specification: `a || b?.c` is `a || (b?.c)`, and `await x?.M()` awaits
    // `x?.M()`.
    conditional_access_expression: $ => prec.right(seq(
      field('condition', choice(
        'this',
        'base',
        $.literal,
        $.interpolated_string_expression,
        $._simple_name,
        $.member_access_expression,
        $.conditional_access_expression,
        $.invocation_expression,
        $.element_access_expression,
        $.tuple_expression,
        $.parenthesized_expression,
        alias($._parenthesized_lvalue_expression, $.parenthesized_expression),
        $.postfix_unary_expression,
        $.object_creation_expression,
        $.implicit_object_creation_expression,
        $.anonymous_object_creation_expression,
        $.array_creation_expression,
        $.implicit_array_creation_expression,
        $.typeof_expression,
        $.sizeof_expression,
        $.checked_expression,
        $.default_expression,
      )),
      '?',
      choice(
        $.member_binding_expression,
        alias($.bracketed_argument_list, $.element_binding_expression),
      ),
    )),

    // `[1, 2]` as a value is a collection expression; an element binding
    // `[i]` is the target of an assignment in an object initializer.
    collection_expression: ($, previous) => prec.dynamic(1, previous),

    // `F(a * b)` is a multiplication. A pointer type is read only where no
    // other reading exists: its dynamic precedence is lower than the dynamic
    // precedence 1 of a declaration expression, which is otherwise ambiguous
    // with an argument.
    pointer_type: ($, previous) => prec.dynamic(-2, previous),

    // Alternate "entry point". Allows parsing a standalone expression.
    semgrep_expression: $ => seq('__SEMGREP_EXPRESSION', $.expression),

    // Metavariables
    identifier: ($, previous) => {
      return choice(
        previous,
        $._semgrep_metavariable
      );
    },

    _semgrep_metavariable: $ => token(/\$[A-Z_][A-Z_0-9]*/),
    semgrep_variadic_metavariable: ($) => /\$\.\.\.[A-Z_][A-Z_0-9]*/,

    parameter: ($, previous) => {
      return choice(
        previous,
        $.ellipsis
      );
    },

    // alt: we could also extend 'identifier' above and allow 'semgrep_variadic_metavariable'
    // there to be more general
    argument: ($, previous) => {
      return choice(
        previous,
        $.semgrep_variadic_metavariable
      );
    },

    declaration: ($, previous) => {
      return choice(
        ...withoutPreprocIf(previous).members,
        $.ellipsis
      );
    },

    // We want ellipses to be interchangeable with namespace member declarations, so
    // we need to add them in to `type_declaration` here.
    type_declaration: ($, previous) => {
      return choice(
        ...previous.members,
        $.ellipsis
      )
    },

    // Ellipses among the members of an extension block.
    _extension_member_declaration: ($, previous) => choice(
      ...previous.members,
      $.ellipsis
    ),

    enum_member_declaration: ($, previous) => choice(
          previous,
	  $.ellipsis,
    ),

    // Statement ellipsis: '...' not followed by ';'
    expression_statement: ($, previous) => {
      return choice(
        previous,
        prec.right(100, seq($.ellipsis, ';')),  // expression ellipsis
        prec.right(100, $.ellipsis),  // statement ellipsis
        seq($.deep_ellipsis, ';'),
        seq($.member_access_ellipsis_expression, ';'),
        seq($._semgrep_metavariable, ';'),
        seq($.typed_metavariable, ';')
      );
    },

    // Expression ellipsis
    expression: ($, previous) => {
      return choice(
        ...previous.members,
        $.ellipsis,
        $.deep_ellipsis,
        $.member_access_ellipsis_expression,
        $.typed_metavariable
      );
    },

    member_access_ellipsis_expression : $ => prec(PREC.DOT, seq(
      field('expression', choice($.expression, $.predefined_type, $._name)),
      choice('.', '->'),
      $.ellipsis
     )),

    // use syntax similar to a cast_expression, but with metavar
    typed_metavariable: $ => prec.right(PREC.CAST, prec.dynamic(1, seq(
      '(',
      field('type', $.type),
      field('metavar', $._semgrep_metavariable),
      ')',
    ))),

    deep_ellipsis: $ => seq(
      '<...', $.expression, '...>'
    ),

    ellipsis: $ => '...',
  }
});
