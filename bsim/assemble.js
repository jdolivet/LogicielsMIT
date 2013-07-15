(function() {
    var root = this; // = window in a browser

    // This can take either a stream or a file/line pair.
    // If it's given a stream as the second argument, it will extract
    // the file, line number and column from that.
    // Otherwise it will assume the second argument to be a filename
    // and the third to be a line number.
    var SyntaxError = function(message, stream_or_file, line) {
        if(stream_or_file instanceof StringStream) {
            this.file = stream_or_file.file();
            this.line = stream_or_file.line_number();
            this.column = stream_or_file.column();
        } else {
            this.file = stream_or_file;
            this.line = line;
            this.column = 0;
        }
        this.message = message;
    };
    SyntaxError.prototype = new Error();
    SyntaxError.prototype.toString = function() {
        return this.file + ":" + this.line + ":" + this.column + ": " + this.message;
    };

    // Reads an octal escape sequence, excluding the leading backslash.
    // Throws a SyntaxError if the sequence is outside the acceptable range (one byte)
    var readOctalStringEscape = function(stream) {
        var sequence = '';
        while(!stream.eol() && sequence.length < 3) {
            if(_.contains('01234567', stream.peek())) {
                sequence += stream.next();
            } else {
                break;
            }
        }
        var value = parseInt(sequence, 8);
        if(value > 255) {
            throw new SyntaxError("Octal escape sequence \\" + sequence + " is larger than one byte (max is \\377)", stream);
        }
        return String.fromCharCode(value);
    };

    // Reads one character from a string and returns it.
    // If the character is equal to end_char, and it's not escaped,
    // returns false instead (this lets you detect end of string)
    var readChar = function(stream, end_char) {
        var chr = stream.next();
        switch(chr) {
        case end_char:
            return false;
        case '\\':
            chr = stream.next();
            switch(chr) {
            case 'b': return '\b'; break;
            case 'f': return '\f'; break;
            case 'n': return '\n'; break;
            case 'r': return '\r'; break;
            case 't': return '\t'; break;
            case '"': return '"'; break;
            case "'": return "'"; break;
            case '\\': return '\\'; break;
            // Allow octal sequences like \123
            case '0': case '1': case '2': case '3':
            case '4': case '5': case '6': case '7':
                stream.backUp(1);
                return readOctalStringEscape(stream);
                break;
            default:
                throw new SyntaxError("Unknown escape sequence \\" + chr + ". (if you want a literal backslash, try \\\\)", stream);
            }
            break;
        default:
            return chr;
        }
    };

    // Reads in a double-quoted string, or throws a SyntaxError if it can't.
    var readString = function(stream) {
        if(stream.next() != '"') {
            throw new SyntaxError("Expected a string here.", stream);
        }
        var out = '';
        while(!stream.eol()) {
            var chr = readChar(stream, '"');
            if(chr === false) return out;
            else out += chr;
        }
        throw new SyntaxError("Unterminated string constant", stream);
    };

    // Parses the given text as a number (as understood by uasm)
    // If this is not possible, returns NaN.
    // This primarily exists as a helper for readNumber.
    var parseNumber = function(text) {
        // Hex
        if(/^0x/i.test(text)) {
            return parseInt(text, 16);
        }
        // Binary
        else if(/^0b/i.test(text)) {
            return parseInt(text.slice(2), 2);
        }
        // Octal
        else if(/^0/i.test(text)) {
            return parseInt(text, 8);
        }
        // Decimal
        else {
            return parseInt(text, 10);
        }
        return NaN;
    };

    // Reads a number out of the stream.
    // If the stream doesn't appear to contain a number, returns null.
    // If the stream does appear to contain a number, but actually doesn't, throws
    // a SyntaxError.
    // If the stream really does contain a number, returns it as a Number.
    var readNumber = function(stream, optional) {
        // This reads more than just sane numbers so we can actually see errors.
        // Anything this matches should be a number, though, so we can safely error
        // out if we can't extract a number from a match.
        var token = stream.match(/^[0-9][\$\.@A-Z0-9_]*/i);
        if(!token) return null; // Not intended as a Number (NiaaN)
        token = token[0];
        var num = parseNumber(token);
        // If whatever we had was Not a Number, then it is a syntax error.
        if(isNaN(num) && !optional) {
            throw new SyntaxError("Incomprehensible number " + token + ". Acceptable bases are hex (0x...), octal (0...), binary (0b...) and decimal.", stream);
        }

        return num;
    };

    // Read any name symbol from the stream.
    // Returns the name of the symbol if it exists, null if there isn't one.
    var readSymbol = function(stream) {
        eatSpace(stream);
        var match = stream.match(/^[\$\.@A-Z_][\$\.@A-Z0-9_]*/i);
        
        if(match) {
            return match[0];
        } else {
            return null;
        }
    };

    // Reads in a 'term', as understood by an Expression.
    // This understands the following as terms:
    // - Integer literals
    // - Symbols (e.g. variable names)
    // - Parenthesised expressions
    // - Characters (single character strings quoted with '')
    // - Negations of the above (any of the above prefixed by a -)
    // Returns the term, whatever it happens to be (number, symbol name, Expression, UnaryOperation)
    var readTerm = function(stream) {
        eatSpace(stream);
        // Is it a number?
        var num = readNumber(stream);
        if(num !== null) return num;

        var symbol = readSymbol(stream);
        if(symbol !== null) return symbol;

        if(stream.peek() == '-' || stream.peek() == '~' || stream.peek() == '+') {
            var unary = stream.next();
            var next = readTerm(stream);
            if(next) {
                return new UnaryOperation(unary, next, stream.file(), stream.line_number());
            } else {
                throw new SyntaxError("Expected value after unary '" + unary + "' operator.", stream);
            }
        }
        if(stream.peek() == '(') {
            stream.next();
            var expression = Expression.parse(stream);
            if(stream.next() != ')') {
                throw new SyntaxError("Expected closing parenthesis.", stream);
            } else if(expression === null) {
                throw new SyntaxError("Expected expression between grouping parentheses.", stream);
            }
            return expression;
        }
        if(stream.peek() == "'") {
            stream.next();
            var chr = readChar(stream, "'");
            if(chr === false) {
                throw new SyntaxError("Zero-character char constant; char constants must have exactly one character.", stream);
            }
            if(stream.next() != "'") {
                throw new SyntaxError("Multi-character char constant; char constants must have exactly one character (for more, try .ascii or .text)", stream);
            }
            return chr.charCodeAt(0);
        };


        return null;
    };

    // Eats spaces and comments (so nothing else needs to worry about either)
    var eatSpace = function(stream) {
        stream.eatSpace();
        if(stream.match(/^\/\//)) {
            stream.skipToEnd();
        }
        if(stream.match(/^\/\*/)) {
            var start_line = stream.line_number();
            while(true) {
                if(stream.match(/^.*\*\//)) {
                    break;
                } else {
                    stream.skipToEnd();
                    if(!stream.next_line()) {
                        throw new SyntaxError("Unclosed block comment (starts here)", stream.file(), start_line);
                    }
                }
            }
        }
    };

    // All of these are generated during a first pass over the file.
    // At this stage we don't know what exists, because we haven't yet processed
    // include files. References are thus generally strings or other instances of
    // these objects.
    function Assignment(name, value, file, line) {
        this.name = name;
        this.value = value;
        this.file = file;
        this.line = line;
    };
    Assignment.prototype.assemble = function(context, out) {
        // Dot is a special case.
        if(this.name === '.') {
            var dot = this.value.evaluate(context, true);
            if(dot < context.dot) {
                throw new SyntaxError("It is illegal to set . to a value lower than its current value (current value: " + context.dot + "; new value: " + dot + ")", this.file, this.line);
            }
            context.dot = dot;
        } else {
            context.symbols[this.name] = this.value.evaluate(context, !!out);
        }
        return null;
    };

    // Represents the location of a label in the code
    function Label(name, file, line) {
        this.name = name;
        this.file = file;
        this.line = line;
    };
    Label.prototype.assemble = function(context, out) {
        context.symbols[this.name] = context.dot;
        context.labels[this.name] = context.dot;
    };

    // Represents an invocation of a macro.
    function MacroInvocation(macro, args, file, line) {
        this.macro = macro;
        this.args = args;
        this.file = file;
        this.line = line;
    };
    // Creates a MacroInvocation. Expects to be given the name of the macro as `token`, and a
    // stream pointing immediately after the macro name 
    // Parses the parenthesised argument list, or throws a SyntaxError if it can't.
    MacroInvocation.parse = function(token, stream) {
        var macro_name = token;
        var args = [];
        if(stream.next() != "(") {
            throw new SyntaxError("Expected macro argument list; this is probably an internal error.", stream);
        }
        if(stream.peek() == ")") {
            stream.next();
            return new MacroInvocation(macro_name, [], stream.file(), stream.line_number());
        }
        while(!stream.eol()) {
            var expression = Expression.parse(stream);
            if(expression === null) {
                throw new SyntaxError("Missing expression in macro argument list.", stream);
            }
            args.push(expression);
            var next = stream.next();
            if(next == ',') {
                continue;
            } else if(next == ')') {
                return new MacroInvocation(macro_name, args, stream.file(), stream.line_number());
            } else {
                if(next === undefined) next = 'end of line';
                throw new SyntaxError("Unexpected '" + next + "'; expecting ',' or ')'", stream);
            }
        }
        throw new SyntaxError("Expected ')' at end of macro argument list; got end of line.", stream);
    };
    MacroInvocation.prototype.assemble = function(context, out) {
        if(!_.has(context.macros, this.macro)) {
            throw new SyntaxError("Macro '" + this.macro + "' has not been defined.", this.file, this.line);
        }
        if(!_.has(context.macros[this.macro], this.args.length)) {
            throw new SyntaxError("Macro '" + this.macro + "' not defined for " + this.args.length + " arguments.", this.file, this.line);
        }
        // Evaluate the arguments, which should all be Expressions.
        var evaluated = [];
        _.each(this.args, function(value) {
            evaluated.push(value.evaluate(context, !!out));
        });
        context.macros[this.macro][this.args.length].transclude(context, evaluated, out);
    };

    // Represents an arithmetic operation; used as part of an Expression.
    function Operation(op, file, line) {
        this.op = op;
        this.file = file;
        this.line = line;
    };
    // Returns the result of performing the Operation on a and b (a op b)
    // a and b will be treated as unsigned integers.
    Operation.prototype.operate = function(a, b) {
        // All operations are done on 32-bit ints. Arithmetic operations are coerced
        // by bitwise OR with 0.
        var ops = {
            '+': function(a, b) { return (a + b)|0; },
            '-': function(a, b) { return (a - b)|0; },
            '/': function(a, b) { return (a / b)|0; },
            '*': function(a, b) { return (a * b)|0; },
            '>>': function(a, b) { return a >>> b; },
            '<<': function(a, b) { return a << b; },
            '%': function(a, b) { return a % b; },
            '&': function(a, b) { return a & b; },
            '|': function(a, b) { return a | b; }
        };
        if(!_.has(ops, this.op)) {
            throw new SyntaxError("Cannot perform operation '" + this.op + "'; no function defined.", this.file, this.line);
        }

        // a and b must both be unsigned, so if they're less than zero we force them to be the unsigned
        // two's-complement representation of the same value.
        if(a < 0) a = 0xFFFFFFFF + a + 1;
        if(b < 0) b = 0xFFFFFFFF + b + 1;
        var result =  ops[this.op](a, b);
        return result;
    };

    // Indicates that the value should be subjected to some unary operation.
    function UnaryOperation(op, value, file, line) {
        this.op = op;
        this.value = value;
        this.file = file;
        this.line = line;
    };
    UnaryOperation.prototype.evaluate = function(context, strict) {
        var ops = {
            '-': function(a) { return -a; },
            '~': function(a) { return ~a; },
            '+': function(a) { return +a; }
        };
        if(this.value instanceof Expression) {
            this.value = this.value.evaluate(context, strict);
        }
        if(!_.has(ops, this.op)) {
            throw new SyntaxError("Cannot perform unary operation '" + this.op + "'; no function defined.", this.file, this.line);
        }
        return ops[this.op](this.value);
    }

    // Represents an 'arithmetic expression'. This includes the degenerate cases of either an integer
    // literal or a symbol name with no operations.
    // Expressions may well contain nested Expressions.
    // Returns null if passed something that doesn't look like an expression
    // Returns an Expression if passed a valid expression
    // Throws a SyntaxError if passed something that looks like an expression but isn't
    function Expression(expression, file, line) {
        this.expression = expression;
        this.file = file;
        this.line = line;
    };
    Expression.parse = function(stream) {
        var terms = []; // List of terms (which we don't generally evaluate while parsing)
        var want_operation = false; // We alternate between expecting a value and an expression.
        while(true) {
            eatSpace(stream);
            if(!want_operation) {
                var term = readTerm(stream);
                if(term !== null) {
                    terms.push(term);
                    want_operation = true;
                    continue;
                } else {
                    // If we can't get a term and we already have some terms, that's a syntax error.
                    // If we don't already have some terms, though, we just assume it's not an expression at all.
                    if(terms.length > 0) {
                        throw new SyntaxError("Expected operand after operator '" + _.last(terms).op + "'", stream);
                    } else {
                        return null;
                    }
                }
            } else {
                // It could be an operation.
                var op = stream.match(/^(?:[\+\-\/\*%&|]|<<|>>)/);
                if(op) {
                    terms.push(new Operation(op[0], stream.file(), stream.line_number()));
                    want_operation = false;
                    continue;
                } else {
                    break;
                }
            }
        }

        return new Expression(terms, stream.file(), stream.line_number());
    };
    // Evaluates an expression, given the variable values in context.
    // If strict is false and it needs a variable that is either not yet set or currently has
    // undefined value (due to forward dependencies), returns 'undefined'.
    // If strict is true, it will instead throw a SyntaxError.
    Expression.prototype.evaluate = function(context, strict) {
        // Expressions should be alternate values and operations.
        // If this isn't true, something has gone wrong (internally; the parser phase
        // should catch it as a syntax error if the user messed up).
        // Operations are always of type Operation.
        // Values can be Numbers (ints), Strings (token names) or Expressions.
        // Numbers are literal, tokens are expanded if possible, and expressions are
        // recursively evaluated.
        // If token expansion fails (because it is undefined), the expression's value is
        // undefined. If this happens during assembly phase one it's ignorable,
        // but during phase two it's a fatal error.
        // (Interestingly, the existing Java implementation sometimes gets this wrong and
        // allows you to use undefinable values, assigning them a value of zero. Let's do
        // better.)
        var self = this;
        // Evaluates a single term of the expression.
        var term = function(t) {
            if(_.isNumber(t)) {
                return t;
            }
            if(_.isString(t)) {
                // . is a special case.
                if(t === '.') {
                    return context.dot;
                }
                var value = context.symbols[t];
                if(value === undefined && strict) {
                    throw new SyntaxError("Symbol '" + t + "' is undefined.", self.file, self.line);
                }
                return value;
            }
            // Evaluate expressions and unary operations recursively.
            if(t instanceof Expression || t instanceof UnaryOperation) {
                return t.evaluate(context, strict);
            }
            // We shouldn't be able to get here.
            console.log(t);
            throw "Unknown term type during expression evaluation.";
        };

        var i = 0;
        var a = term(this.expression[i++]);
        if(a === undefined) { // 'strict' handling is done in term().
            return undefined;
        }

        while(i < this.expression.length) {
            var operation = this.expression[i++];
            var b = term(this.expression[i++]);
            if(b === undefined) {
                return undefined;
            }
            if(!(operation instanceof Operation)) {
                throw new SyntaxError("Internal error evaluating expression: expected operation but didn't get one!", this.file, this.line);
            }
            a = operation.operate(a, b);
        }

        return a;
    };
    Expression.prototype.assemble = function(context, out) {
        var value = this.evaluate(context, !!out);
        if(out) out[context.dot] = value;
        context.dot += 1;
    };

    // Represents a Macro definition.
    function Macro(name, parameters, instructions, file, line) {
        this.name = name;
        this.parameters = parameters;
        this.instructions = instructions;
        this.file = file;
        this.line = line;
    };
    Macro.prototype.assemble = function(context, out) {
        if(out) return; // Only evalute macro definitions on first parse to avoid redefinition errors.
        if(!_.has(context.macros, this.name)) {
            context.macros[this.name] = {};
        }
        if(_.has(context.macros[this.name], this.parameters.length)) {
            var old = context.macros[this.name][this.parameters.length];
            throw new SyntaxError("Redefinition of " + this.parameters.length + "-argument macro " + this.name + ". (Original at " + old.file + ":" + old.line + ")", this.file, this.line);
        }
        context.macros[this.name][this.parameters.length] = this;
    };
    // Called by MacroInvocation to put a macro in place during assembly.
    Macro.prototype.transclude = function(context, args, out) {
        if(args.length != this.parameters.length) {
            throw "Wrong number of parameters in Macro transclude (MacroInvocation should not permit this!)";
        }
        // Macros have their own scope, so create a new scope object for them.
        var old_scope = context.symbols;
        var scope = _.extend({}, context.symbols, _.object(this.parameters, args));
        context.symbols = scope;

        _.each(this.instructions, function(instruction) {
            instruction.assemble(context, out);
        });
        // Revert back to the old scope.
        context.symbols = old_scope;
    };

    // Represents a .include statement.
    function Include(filename, file, line) {
        this.filename = filename;
        this.file = file;
        this.line = line;
        this.instructions = null;
    };
    Include.parse = function(stream) {
        var filename = readString(stream);
        return new Include(filename, stream.file(), stream.line_number());
    };
    Include.prototype.assemble = function(context, out) {
        if(!this.instructions) {
            throw "Attempting to assemble Include without parsing file contents.";
        }
        _.each(this.instructions, function(instruction) {
            instruction.assemble(context, out);
        });
    }

    // Represents a .align statement.
    function Align(expression, file, line) {
        this.expression = expression;
        this.file = file;
        this.line = line;
    };
    Align.parse = function(stream) {
        var expression = Expression.parse(stream);
        return new Align(expression, stream.file(), stream.line_number());
    }
    Align.prototype.assemble = function(context, out) {
        var align = this.expression ? this.expression.evaluate(context, true) : 4;
        if(context.dot % align === 0) return;
        context.dot = context.dot + (align - (context.dot % align));
    }

    // Represnts both .ascii (null_terminated = false) and .text (null_terminated = true)
    function AssemblyString(text, null_terminated, file, line) {
        this.text = text;
        this.null_terminated = null_terminated;
        this.file = file;
        this.line = line;
    };
    AssemblyString.prototype.assemble = function(context, out) {
        if(out) {
            for(var i = 0; i < this.text.length; ++i) {
                out[context.dot++] = this.text.charCodeAt(i);
            }
            if(this.null_terminated) out[context.dot++] = 0;
        } else {
            context.dot += this.text.length;
            if(this.null_terminated) context.dot += 1;
        }
        // Interesting undocumented tidbit: .text aligns!
        // This wasted at least an hour.
        if(this.null_terminated) {
            if(context.dot % 4 !== 0) {
                context.dot += (4 - (context.dot % 4));
            }
        }
    };

    // Represents .breakpoint
    function Breakpoint(file, line) {
        this.file = file;
        this.line = line;
    };
    Breakpoint.prototype.assemble = function(context, out) {
        if(out) context.breakpoints.push(context.dot);
    }

    // Represents .protect
    var Protect = function(file, line) {
        this.file = file;
        this.line = line;
    };

    // Represents .unprotect
    var Unprotect = function(file, line) {
        this.file = file;
        this.line = line;
    };

    // Represents .options
    var Options = function(options, file, line) {
        this.options = options;
        this.file = file;
        this.line = line;
    };

    // Public Assembler interface. Constructor takes no arguments.
    var Assembler = function() {
        var mParsedFiles = {};
        var mPendingIncludes = [];

        // Parses a macro definition
        var parse_macro = function(stream) {
            var macro_name = readSymbol(stream);
            if(macro_name === null) {
                throw new SyntaxError("Macro definitions must include a name.", stream);
            }
            var macro_args = [];
            eatSpace(stream);
            if(stream.next() != '(') {
                throw new SyntaxError("Macro definitions must include a parenthesised argument list.", stream);
            }
            while(true) {
                if(stream.peek() == ')') {
                    stream.next();
                    break;
                } else {
                    var macro_arg = readSymbol(stream);
                    if(macro_arg === null) {
                        throw new SyntaxError("Macro arguments must be valid symbol names", stream);
                    }
                    macro_args.push(macro_arg);
                    eatSpace(stream);
                    var next = stream.next();
                    if(next == ')') {
                        break;
                    }
                    if(next != ',') {
                        throw new SyntaxError("Expected comma ',' or close parenthesis ')' after macro argument.", stream);
                    }
                }
            }
            var start_line = stream.line_number();
            var macro_content = parse(stream, true);
            var macro = new Macro(macro_name, macro_args, macro_content, stream.file(), start_line);
            return macro;
        };

        // Parses a file (or a macro, if is_macro is true)
        var parse = function(stream, is_macro) {
            var fileContent = [];
            var allow_multiple_lines = !is_macro; // Macros are single-line by default
            // Helpful bits of state
            var eatingComments = false;

            // If we're in a macro, if the first character we receive is an open brace {,
            // we are allowed to span multiple lines (indeed, we run until we find a close brace)
            eatSpace(stream);
            if(is_macro && stream.peek() == '{') {
                stream.next();
                allow_multiple_lines = true;
            }
        parse_loop:
            do {
                while(!stream.eol()) {
                    // Handle a multi-line comment if we're in one.
                    if(eatingComments) {
                        if(!stream.match(/^.*\*/)) {
                            stream.skipToEnd();
                        } else {
                            eatingComments = false;
                        }
                        continue;
                    }

                    // Skip any whitespace
                    if(eatSpace(stream)) continue;
                    // If we're at the end of the line, continue.
                    if(stream.eol()) break;

                    // If we're in a multi-line macro and we find a }, it's time for us to exit.
                    if(is_macro && allow_multiple_lines && stream.peek() == "}") {
                        stream.next();
                        break parse_loop;
                    }

                    // Skip to the end of the line on single-line comments.
                    if(stream.match('//')) {
                        stream.skipToEnd();
                        continue;
                    }

                    // Handle multi-line comments
                    if(stream.match('/*')) {
                        if(!stream.match(/^.*\*\//)) {
                            stream.skipToEnd();
                            eatingComments = true;
                        }
                        continue;
                    }

                    // Pull out a token. Be ready to put it back, though.
                    var start_pos = stream.pos;
                    var token = readSymbol(stream);
                    
                    eatSpace(stream);
                    if(token) {
                        // Check for commands
                        if(token[0] == '.' && token.length > 1) {
                            var command = token.slice(1);
                            switch(command) {
                            case "include":
                                var include = Include.parse(stream);
                                if(!_.contains(mPendingIncludes, include.filename)) {
                                    mPendingIncludes.push(include.filename);
                                }
                                fileContent.push(include);
                                break;
                            case "macro":
                                fileContent.push(parse_macro(stream));
                                break;
                            case "align":
                                fileContent.push(Align.parse(stream));
                                break;
                            case "ascii":
                            case "text":
                                var ascii = readString(stream);
                                fileContent.push(new AssemblyString(ascii, command == "text", stream.file(), stream.line_number()));
                                break;
                            case "breakpoint":
                                fileContent.push(new Breakpoint(stream.file(), stream.line_number()));
                                break;
                            default:
                                stream.skipToEnd();
                                throw new SyntaxError("Unrecognised directive '." + command + "'", stream);
                            }
                            continue;
                        }

                        // Check if we're defining a label
                        if(stream.peek() == ':') {
                            stream.next();
                            var label = new Label(token, stream.file(), stream.line_number());
                            fileContent.push(label);
                            continue;
                        }

                        // Or assigning something
                        if(stream.peek() == '=') {
                            
                            stream.next();
                            var expression = Expression.parse(stream);
                            var assignment = new Assignment(token, expression, stream.file(), stream.line_number());
                            fileContent.push(assignment);
                            continue;
                        }

                        // Or calling a macro
                        if(stream.peek() == '(') {
                            var invocation = MacroInvocation.parse(token, stream, stream);
                            fileContent.push(invocation);
                            continue;
                        }

                        // If we get here, put the token back and hand off to the expression parser
                        stream.pos = start_pos;
                    }

                    // This is an expression of some form
                    var expression = Expression.parse(stream)
                    fileContent.push(expression);

                    if(expression === null) {
                        // This is a collection of ways we can get here.
                        if(stream.peek() == ')') {
                            throw new SyntaxError("Unexpected closing parenthesis.", stream);
                        }
                        if(stream.peek() == '=') {
                            throw new SyntaxError("Cannot assign to integer literals or expressions.", stream);
                        }
                        if(stream.peek() == '{') {
                            throw new SyntaxError("An opening brace '{' is only permitted at the beginning of a macro definition.", stream);
                        }
                        if(stream.peek() == '}') {
                            throw new SyntaxError("Unexpected closing brace '}' without matching open brace '{'", stream);
                        }

                        // This is just the user being unreasonable
                        var bad_thing = stream.match(/^[^\s]+/) || stream.match(/^[^\b]+/) || stream.peek();
                        throw new SyntaxError("Unexpected '" + bad_thing + "'; giving up.", stream);
                    }
                }
            } while(allow_multiple_lines && stream.next_line());
            return fileContent;
        };

        // Given a syntax tree, returns a Uint8Array representing the program
        // Alternatively, throws a SyntaxError.
        var run_assembly = function(syntax) {
            var context = {
                symbols: {},
                macros: {},
                dot: 0,
                // Things to be passed out to the driver.
                breakpoints: [],
                labels: {}
            };
            // First pass: figure out where everything goes.
             _.each(syntax, function(item) {
                item.assemble(context);
            });
            // Reset our start position, but keep the values defined.
            var size = context.dot;
            context.dot = 0;
            var memory = new Uint8Array(size);
            // Now do it again! Put things into our memory image this time.
            _.each(syntax, function(item) {
                item.assemble(context, memory);
            });
            return {
                image: memory,
                breakpoints: context.breakpoints,
                labels: context.labels
            };
        };

        // Public driver function.
        // file: the name of the file
        // content: the contents of the file
        // callback(false, error_list): called on failure. error_list is a list of SyntaxErrors, if any
        // callback(true, bytecode): called on success. bytecode is a Uint8Array containing the result of compilation.
        this.assemble = function(file, content, callback) {
            var stream = new StringStream(new FileStream(content, file));
            var errors = [];
            do {
                try {
                    var syntax = parse(stream);
                } catch(e) {
                    if(e instanceof SyntaxError) {
                        errors.push(e);
                    } else {
                        throw e;
                    }
                }
            } while(stream.next_line());
            if(errors.length) {
                callback(false, errors);
            } else {
                try {
                    var code = run_assembly(syntax);
                } catch(e) {
                    if(e instanceof SyntaxError) {
                        errors.push(e);
                    } else {
                        throw e;
                    }
                }
                console.log(code);
                if(errors.length) {
                    callback(false, errors);
                } else {
                    callback(true, code);
                }
            }
        };
    };

    root.BetaAssembler = Assembler;
})();