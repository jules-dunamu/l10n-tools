import cheerio from 'cheerio'
import * as babelParser from '@babel/parser'
import log from 'npmlog'
import traverse from '@babel/traverse'
import {findPoEntry, PoEntryBuilder, setPoEntry} from './po'
import * as gettextParser from 'gettext-parser'
import * as ts from 'typescript'
import Engine from 'php-parser'

function getBabelParserOptions(options) {
    options.plugins = [
        'doExpressions',
        'functionBind',
        'exportExtensions',
        'exportDefaultFrom',
        'exportNamespaceFrom',
        'optionalChaining',
        'nullishCoalescingOperator',
        'decorators2',
        'functionSent',
        'throwExpressions',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'dynamicImport',
        'importMeta',
        'numericSeparator',
        'bigInt',
        'optionalCatchBinding',
        'objectRestSpread',
        'asyncGenerators'
    ]
    return options
}

export class PotExtractor {
    constructor (po, options) {
        this.po = po
        this.options = Object.assign({
            keywords: [],
            tagNames: [],
            attrNames: [],
            filterNames: [],
            markers: [],
            exprAttrs: [],
            cocosKeywords: {},
        }, options)

        this.filterExprs = this.options.filterNames.map(filterName => {
            return new RegExp('^(.*)\\|\\s*' + filterName)
        })
    }

    static create (domainName, options) {
        return new PotExtractor({
            charset: 'utf-8',
            headers: {
                'project-id-version': domainName,
                'mime-version': '1.0',
                'content-type': 'text/plain; charset=utf-8',
                'content-transfer-encoding': '8bit'
            },
            translations: {}
        }, options)
    }

    _evaluateJsArgumentValues (node) {
        if (node.type === 'StringLiteral') {
            return [node.value]
        } else if (node.type === 'Identifier') {
            throw new Error('cannot extract translations from variable, use string literal directly')
        } else if (node.type === 'MemberExpression') {
            throw new Error('cannot extract translations from variable, use string literal directly')
        } else if (node.type === 'BinaryExpression' && node.operator === '+') {
            const values = []
            for (const leftValue of this._evaluateJsArgumentValues(node.left)) {
                for (const rightValue of this._evaluateJsArgumentValues(node.right)) {
                    values.push(leftValue + rightValue)
                }
            }
            return values
        } else if (node.type === 'ConditionalExpression') {
            return this._evaluateJsArgumentValues(node.consequent)
                .concat(this._evaluateJsArgumentValues(node.alternate))
        } else {
            throw new Error(`cannot extract translations from '${node.type}' node, use string literal directly`)
        }
    }

    extractJsNode (filename, src, ast) {
        traverse(ast, {
            enter: path => {
                const node = path.node
                if (node.type === 'CallExpression') {
                    for (const keyword of this.options.keywords) {
                        const dotIndex = keyword.indexOf('.')
                        if (dotIndex >= 0) {
                            if (node.callee.type === 'MemberExpression') {
                                const objectName = keyword.substring(0, dotIndex)
                                const propName = keyword.substring(dotIndex + 1)
                                if ((objectName === 'this' && node.callee.object.type === 'ThisExpression')
                                    || (node.callee.object.type === 'Identifier' && node.callee.object.name === objectName)) {
                                    if (node.callee.property.type === 'Identifier' && node.callee.property.name === propName) {
                                        try {
                                            const ids = this._evaluateJsArgumentValues(node.arguments[0])
                                            for (const id of ids) {
                                                this.addMessage({filename, line: node.loc.start.line}, id)
                                            }
                                        } catch (err) {
                                            log.warn('extractJsNode', err.message)
                                            log.warn('extractJsNode', `'${src.substring(node.start, node.end)}': (${node.loc.filename}:${node.loc.start.line})`)
                                        }
                                    }
                                }
                            }
                        } else {
                            if (node.callee.type === 'Identifier') {
                                if (node.callee.name === keyword) {
                                    try {
                                        const ids = this._evaluateJsArgumentValues(node.arguments[0])
                                        for (const id of ids) {
                                            this.addMessage({filename, line: node.loc.start.line}, id)
                                        }
                                    } catch (err) {
                                        log.warn('extractJsNode', err.message)
                                        log.warn('extractJsNode', `'${src.substring(node.start, node.end)}': (${node.loc.filename}:${node.loc.start.line})`)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })
    }

    extractJsModule (filename, src, startLine = 1) {
        try {
            const ast = babelParser.parse(src, getBabelParserOptions({
                sourceType: 'module',
                sourceFilename: filename,
                startLine: startLine
            }))
            this.extractJsNode(filename, src, ast)
        } catch (err) {
            log.warn('extractJsModule', `error parsing '${src.split(/\n/g)[err.loc.line - 1].trim()}' (${filename}:${err.loc.line})`)
        }
    }

    extractVue (filename, src, startLine = 1) {
        const $ = cheerio.load(src, {decodeEntities: false, withStartIndices: true})

        $.root().children().each((index, elem) => {
            if (elem.children.length === 0) {
                return
            }

            if (elem.name === 'template') {
                const content = $(elem).html()
                if (content) {
                    const line = getLineTo(src, elem.children[0].startIndex, startLine)
                    this.extractTemplate(filename, content, line)
                }
            } else if (elem.name === 'script') {
                const content = $(elem).html()
                if (content) {
                    const type = elem.attribs.type
                    if (!type || type === 'text/javascript') {
                        const line = getLineTo(src, elem.children[0].startIndex, startLine)
                        this.extractJsModule(filename, content, line)
                    }
                }
            }
        })
    }

    extractTemplate (filename, src, startLine = 1) {
        const $ = cheerio.load(src, {decodeEntities: false, withStartIndices: true})

        $('*').each((index, elem) => {
            const node = $(elem)

            if (elem.name === 'script') {
                const content = $(elem).html()
                if (content) {
                    const type = elem.attribs.type
                    if (!type || type === 'text/javascript') {
                        const line = getLineTo(src, elem.children[0].startIndex, startLine)
                        this.extractJsModule(filename, content, line)
                    } else if (type === 'text/ng-template') {
                        const line = getLineTo(src, elem.children[0].startIndex, startLine)
                        this.extractTemplate(filename, content, line)
                    }
                }
            }

            if (this.options.tagNames.includes(elem.name)) {
                const id = node.html().trim()
                if (id) {
                    const line = getLineTo(src, elem.children[0].startIndex, startLine)
                    const plural = elem.attribs['translate-plural'] || null
                    const comment = elem.attribs['translate-comment'] || null
                    const context = elem.attribs['translate-context'] || null
                    this.addMessage({filename, line}, id, {plural, comment, context})
                }
            }

            if (this.options.attrNames.some(attrName => elem.attribs.hasOwnProperty(attrName))) {
                const id = node.html().trim()
                if (id) {
                    const line = getLineTo(src, elem.children[0].startIndex, startLine)
                    const plural = elem.attribs['translate-plural'] || null
                    const comment = elem.attribs['translate-comment'] || null
                    const context = elem.attribs['translate-context'] || null
                    this.addMessage({filename, line}, id, {plural, comment, context})
                }
            }

            for (const [attr, content] of Object.entries(elem.attribs)) {
                if (content && this.options.exprAttrs.some(pattern => attr.match(pattern))) {
                    let contentIndex = 0
                    const attrIndex = src.substr(elem.startIndex).indexOf(attr)
                    if (attrIndex >= 0) {
                        contentIndex = attrIndex + attr.length
                        while (/[=\s]/.test(src.substr(elem.startIndex + contentIndex)[0])) {
                            contentIndex++
                        }
                        if (['\'', '"'].includes(src.substr(elem.startIndex + contentIndex)[0])) {
                            contentIndex++
                        }
                    }
                    const line = getLineTo(src, elem.startIndex + contentIndex, startLine)
                    this.extractJsExpression(filename, content, line)
                }
            }
        })

        for (const marker of this.options.markers) {
            let srcIndex = 0
            while (true) {
                let startOffset = src.indexOf(marker.start, srcIndex)
                if (startOffset === -1) {
                    break
                }

                startOffset += marker.start.length
                const endOffset = src.indexOf(marker.end, startOffset)
                if (endOffset === -1) {
                    srcIndex = startOffset
                    continue
                }

                const content = src.substring(startOffset, endOffset)
                const line = getLineTo(src, startOffset, startLine)
                this.extractMarkerExpression(filename, content, marker, line)

                srcIndex = endOffset + marker.end.length
            }
        }
    }

    extractMarkerExpression (filename, src, marker, startLine = 1) {
        if (!marker.type || marker.type === 'js') {
            this.extractJsExpression(filename, src, startLine)
        } else if (marker.type === 'angular') {
            this.extractAngularExpression(filename, src, startLine)
        }
    }

    extractJsExpression (filename, src, startLine = 1) {
        try {
            const ast = babelParser.parse('(' + src + ')', getBabelParserOptions({
                sourceType: 'script',
                sourceFilename: filename,
                startLine: startLine
            }))
            this.extractJsNode(filename, src, ast)
        } catch (err) {
            log.warn('extractJsExpression', `error parsing '${src}' (${filename}:${startLine})`, err)
        }
    }

    extractAngularExpression (filename, src, startLine = 1) {
        for (const filterExpr of this.filterExprs) {
            const match = filterExpr.exec(src)
            if (match == null) {
                continue
            }

            const contentExpr = match[1]
            try {
                const node = babelParser.parseExpression(contentExpr, getBabelParserOptions({
                    sourceType: 'script',
                    sourceFilename: filename,
                    startLine: startLine
                }))
                try {
                    const ids = this._evaluateJsArgumentValues(node)
                    for (const id of ids) {
                        this.addMessage({filename, line: node.loc.start.line}, id)
                    }
                } catch (err) {
                    log.warn('extractAngularExpression', err.message)
                    log.warn('extractAngularExpression', `${src}: (${node.loc.filename}:${node.loc.start.line})`)
                }
            } catch (err) {
                log.warn('extractAngularExpression', `cannot extract from '${src}' (${filename}:${startLine})`)
            }
        }
    }

    _evaluateTsArgumentValues (node) {
        if (node.kind === ts.SyntaxKind.StringLiteral) {
            return [node.text]
        } else if (node.kind === ts.SyntaxKind.Identifier) {
            throw new Error('cannot extract translations from variable, use string literal directly')
        } else if (node.kind === ts.SyntaxKind.PropertyAccessExpression) {
            throw new Error('cannot extract translations from variable, use string literal directly')
        } else if (node.kind === ts.SyntaxKind.BinaryExpression && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const values = []
            for (const leftValue of this._evaluateTsArgumentValues(node.left)) {
                for (const rightValue of this._evaluateTsArgumentValues(node.right)) {
                    values.push(leftValue + rightValue)
                }
            }
            return values
        } else if (node.kind === ts.SyntaxKind.ConditionalExpression) {
            return this._evaluateTsArgumentValues(node.whenTrue)
                .concat(this._evaluateTsArgumentValues(node.whenFalse))
        } else {
            throw new Error(`cannot extract translations from '${node.kind}' node, use string literal directly`)
        }
    }

    extractTsNode (filename, src, ast, startLine = 1) {
        const visit = node => {
            if (node.kind === ts.SyntaxKind.CallExpression) {
                const pos = findNonSpace(src, node.pos)
                for (const keyword of this.options.keywords) {
                    const dotIndex = keyword.indexOf('.')
                    if (dotIndex >= 0) {
                        if (node.expression.kind === ts.SyntaxKind.PropertyAccessExpression) {
                            const objectName = keyword.substring(0, dotIndex)
                            const propName = keyword.substring(dotIndex + 1)
                            const callee = node.expression.expression
                            if ((objectName === 'this' && callee.kind === ts.SyntaxKind.ThisKeyword)
                                || (callee.kind === ts.SyntaxKind.Identifier && callee.text === objectName)) {
                                const name = node.expression.name
                                if (name.kind === ts.SyntaxKind.Identifier && name.text === propName) {
                                    try {
                                        const ids = this._evaluateTsArgumentValues(node.arguments[0])
                                        for (const id of ids) {
                                            this.addMessage({filename, line: getLineTo(src, pos, startLine)}, id)
                                        }
                                    } catch (err) {
                                        log.warn('extractTsNode', err.message)
                                        log.warn('extractTsNode', `'${src.substring(pos, node.end)}': (${filename}:${getLineTo(src, pos, startLine)})`)
                                    }
                                }
                            }
                        }
                    } else {
                        if (node.expression.kind === ts.SyntaxKind.Identifier) {
                            const callee = node.expression
                            if (callee.text === keyword) {
                                try {
                                    const ids = this._evaluateTsArgumentValues(node.arguments[0])
                                    for (const id of ids) {
                                        this.addMessage({filename, line: getLineTo(src, pos, startLine)}, id)
                                    }
                                } catch (err) {
                                    log.warn('extractTsNode', err.message)
                                    log.warn('extractTsNode', `'${src.substring(pos, node.end)}': (${filename}:${getLineTo(src, pos, startLine)})`)
                                }
                            }
                        }
                    }
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(ast)
    }

    extractTsModule (filename, src, startLine = 1) {
        try {
            const ast = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true)
            this.extractTsNode(filename, src, ast, startLine)
        } catch (err) {
            log.warn('extractJsModule', `error parsing '${src.split(/\n/g)[err.loc.line - 1].trim()}' (${filename}:${err.loc.line})`)
        }
    }

    extractCocosAsset (filename, src) {
        const objs = JSON.parse(src)
        for (const obj of objs) {
            if (!obj.hasOwnProperty('__type__')) {
                return
            }

            const type = obj['__type__']
            if (this.options.cocosKeywords.hasOwnProperty(type)) {
                const name = this.options.cocosKeywords[type]
                const id = obj[name]
                if (id) {
                    const path = getCocosNodePath(objs, obj)
                    this.addMessage({filename, line: path}, id)
                }
            }
        }
    }

    _evaluatePhpArgumentValues (node) {
        if (node.kind === 'string') {
            return [node.value]
        } else if (node.kind === 'encapsed') {
            throw new Error('cannot extract translations from interpolated string, use sprintf for formatting')
        } else if (node.kind === 'variable') {
            throw new Error('cannot extract translations from variable, use string literal directly')
        } else if (node.kind === 'propertylookup') {
            throw new Error('cannot extract translations from variable, use string literal directly')
        } else if (node.kind === 'bin' && node.type === '+') {
            const values = []
            for (const leftValue of this._evaluatePhpArgumentValues(node.left)) {
                for (const rightValue of this._evaluatePhpArgumentValues(node.right)) {
                    values.push(leftValue + rightValue)
                }
            }
            return values
        } else if (node.kind === 'retif') {
            return this._evaluatePhpArgumentValues(node.trueExpr)
                .concat(this._evaluatePhpArgumentValues(node.falseExpr))
        } else {
            throw new Error(`cannot extract translations from '${node.kind}' node, use string literal directly`)
        }
    }

    extractPhpNode (filename, src, Node, ast, startLine = 1) {
        const visit = node => {
            if (node.kind === 'call') {
                for (const keyword of this.options.keywords) {
                    if (node.what.kind === 'identifier') {
                        if (node.what.name === keyword) {
                            const startOffset = src.substr(0, node.loc.start.offset).lastIndexOf(keyword)
                            try {
                                const ids = this._evaluatePhpArgumentValues(node.arguments[0])
                                for (const id of ids) {
                                    this.addMessage({filename, line: node.loc.start.line}, id)
                                }
                            } catch (err) {
                                log.warn('extractPhpNode', err.message)
                                log.warn('extractPhpNode', `'${src.substring(startOffset, node.loc.end.offset)}': (${filename}:${node.loc.start.line})`)
                            }
                        }
                    }
                }
            }

            for (const key in node) {
                // noinspection JSUnfilteredForInLoop
                const value = node[key]
                if (Array.isArray(value)) {
                    for (const child of value) {
                        if (child instanceof Node) {
                            visit(child)
                        }
                    }
                } else if (value instanceof Node) {
                    visit(value)
                }
            }
        }
        visit(ast)
    }

    extractPhpCode (filename, src, startLine = 1) {
        const parser = new Engine({
            parser: {
                extractDoc: true,
                locations: true,
                php7: true
            },
            ast: {
                withPositions: true
            }
        })

        try {
            const ast = parser.parseCode(src)
            const Node = parser.ast.constructor.prototype['node']
            this.extractPhpNode(filename, src, Node, ast, startLine)
        } catch (err) {
            log.warn('extractPhpCode', `error parsing '${src.split(/\n/g)[err.loc.line - 1].trim()}' (${filename}:${err.loc.line})`)
        }
    }

    addMessage ({filename, line}, id, {plural = null, comment = null, context = null, allowSpaceInId = false} = {}) {
        const poEntry = findPoEntry(this.po, context, id)
        const builder = poEntry ? PoEntryBuilder.fromPoEntry(poEntry) : new PoEntryBuilder(context, id, {allowSpaceInId})

        builder.addReference(filename, line)
        if (plural) {
            builder.setPlural(plural)
        }
        if (comment) {
            builder.addComment(comment)
        }

        setPoEntry(this.po, builder.toPoEntry())
    }

    getPo () {
        return this.po
    }

    toString () {
        return gettextParser.po.compile(this.po, {sort: true})
    }
}

function findNonSpace(src, index) {
    const match = /^(\s*)\S/.exec(src.substring(index))
    if (match) {
        return index + match[1].length
    } else {
        return index
    }
}

function getCocosNodePath (nodes, obj) {
    if (obj.hasOwnProperty('node')) {
        const node = nodes[obj['node']['__id__']]
        return getCocosNodePath(nodes, node)
    } else if (obj.hasOwnProperty('_parent')) {
        if (obj['_parent']) {
            const parent = nodes[obj['_parent']['__id__']]
            const name = obj['_name']
            const path = getCocosNodePath(nodes, parent)
            if (path) {
                return path + '.' + name
            } else {
                return name
            }
        } else {
            return ''
        }
    } else {
        throw new Error(`unknown cocos object: ${JSON.stringify(obj)}`)
    }
}

export function getLineTo(src, index, startLine = 1) {
    const matches = src.substr(0, index).match(/\n/g)
    if (!matches) {
        return startLine
    }
    return startLine + matches.length
}
