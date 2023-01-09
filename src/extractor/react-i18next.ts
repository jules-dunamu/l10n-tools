import type {Config} from '../config'
import * as fs from 'fs'
import log from 'npmlog'
import * as path from 'path'
import {getSrcPaths} from '../common'
import {PotExtractor} from '../pot-extractor'

export default async function (domainName: string, config: Config, potPath: string) {
    const srcPaths = await getSrcPaths(config, ['.js', '.ts', '.tsx'])
    const keywords = new Set(config.get<string[]>('keywords', []))
    keywords.add('i18next.t')
    keywords.add('i18n.t')
    keywords.add('t')
    keywords.add('_t')
    keywords.add('mmtc.i18n.t')

    const extractor = PotExtractor.create(domainName, {
        tagNames: ['react-i18next'],
        attrNames: ['i18nKey'],
        markers: [{start: '{', end: '}'}],
        keywords: keywords
    })
    log.info('extractPot', 'extracting from .js, .ts, .tsx files')
    for (const srcPath of srcPaths) {
        log.verbose('extractPot', `processing '${srcPath}'`)
        const ext = path.extname(srcPath)
        if (ext === '.js') {
            const input = fs.readFileSync(srcPath, {encoding: 'utf-8'})
            extractor.extractJsModule(srcPath, input)
        } else if (ext === '.ts') {
            const input = fs.readFileSync(srcPath, {encoding: 'utf-8'})
            extractor.extractTsModule(srcPath, input)
        } else if (ext === '.tsx') {
            const input = fs.readFileSync(srcPath, {encoding: 'utf-8'})
            extractor.extractTsModule(srcPath, input)
        } else {
            log.warn('extractPot', `skipping '${srcPath}': unknown extension`)
        }
    }
    fs.writeFileSync(potPath, extractor.toString())
}
