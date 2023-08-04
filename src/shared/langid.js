import compat from './compat.js';
import {product} from './func.js'

/**
 * Temporary fix around few models, bad classified, and similar looking languages.
 * From https://github.com/bitextor/bicleaner/blob/3df2b2e5e2044a27b4f95b83710be7c751267e5c/bicleaner/bicleaner_hardrules.py#L50
 * @type {Set<String>[]}
 */
const SimilarLanguages = [
    new Set(['es', 'ca', 'gl', 'pt']),
    new Set(['no', 'nb', 'nn', 'da']) // no == nb for bicleaner
];

/**
 * @typedef {Object} TranslationModel
 * @property {String} from
 * @property {String} to
 * @property {Boolean} local
 */

/**
 * @typedef {Object} TranslationProvider
 * @property {Promise<TranslationModel[]>} registry
 * @property {(request:Object) => Promise<Object>} translate
 */ 

/**
 * Language detection function that also provides a sorted list of
 * from->to language pairs, based on the detected language, the preferred
 * target language, and what models are available.
 * @param {{sample:String, suggested:{[lang:String]: Number}}}
 * @param {Promise<TranslationModel[]>} registry
 * @return {Promise<{
 *      from:String|Undefined,
 *      to:String|Undefined,
 *      models: {
 *          from:String,
 *          to:String,
 *          pivot: Boolean,
 *          models: number[]
 *      }[]
 *  }>}
 */
export async function detectLanguage({sample, suggested}, registry, options) {
    if (!sample)
        throw new Error('Empty sample');

    const [detected, models] = await Promise.all([
        compat.i18n.detectLanguage(sample),
        registry
    ]);

    const modelsFromEng = models.filter(({from}) => from === 'en');
    const modelsToEng = models.filter(({to}) => to === 'en');

    // List of all available from->to translation pairs including ones that we
    // achieve by pivoting through English.
    const pairs = [
        ...models.map(model => ({from: model.from, to: model.to, pivot: null, models: [model]})),
        ...Array.from(product(modelsToEng, modelsFromEng))
            .filter(([{from}, {to}]) => from !== to)
            .map(([from, to]) => ({from: from.from, to: to.to, pivot: 'en', models: [from, to]}))
    ];

    // {[lang]: 0.0 .. 1.0} map of likeliness the page is in this language
    /** @type {{[lang:String]: Number }} **/
    let confidence = Object.fromEntries(detected.languages.map(({language, percentage}) => [language, percentage / 100]));

    // Take suggestions into account
    Object.entries(suggested || {}).forEach(([lang, score]) => {
        lang = lang.substr(0, 2); // TODO: not strip everything down to two letters
        confidence[lang] = Math.max(score, confidence[lang] || 0.0);
    });

    // Work-around for language pairs that are close together
    Object.entries(confidence).forEach(([lang, score]) => {
        SimilarLanguages.forEach(group => {
            if (group.has(lang)) {
                group.forEach(other => {
                    if (!(other in confidence))
                        confidence[other] = score / 2; // little bit lower though
                })
            }
        })
    });

    // Fetch the languages that the browser says the user accepts (i.e Accept header)
    /** @type {String[]} **/
    let accepted = await compat.i18n.getAcceptLanguages();

    // TODO: right now all our models are just two-letter codes instead of BCP-47 :(
    accepted = accepted.map(language => language.substr(0, 2))

    // If the user has a preference, put that up front
    if (options?.preferred)
        accepted.unshift(options.preferred);

    // Remove duplicates
    accepted = accepted.filter((val, index, values) => values.indexOf(val, index + 1) === -1)

    // {[lang]: 0.0 .. 1.0} map of likeliness the user wants to translate to this language.
    /** @type {{[lang:String]: Number }} */
    const preferred = accepted.reduce((preferred, language, i, languages) => {
        return language in preferred
            ? preferred
            : {...preferred, [language]: 1.0 - (i / languages.length)};
    }, {});

    // Function to score a translation model. Higher score is better
    const score = ({from, to, pivot, models}) => {
        return 1.0 * (confidence[from] || 0.0)                                                  // from language is good
             + 0.5 * (preferred[to] || 0.0)                                                     // to language is good
             + 0.2 * (pivot ? 0.0 : 1.0)                                                        // preferably don't pivot
             + 0.1 * (1.0 / models.reduce((acc, model) => acc + model.local ? 0.0 : 1.0, 1.0))  // prefer local models
    };

    // Sort our possible models, best one first
    pairs.sort((a, b) => score(b) - score(a));

    // console.log({
    //     accepted,
    //     preferred,
    //     confidence,
    //     pairs: pairs.map(pair => ({...pair, score: score(pair)}))
    // });

    // (Using pairs instead of confidence and preferred because we prefer a pair
    // we can actually translate to above nothing every time right now.)
    return {
        from: pairs.length ? pairs[0].from : undefined,
        to: pairs.length ? pairs[0].to : undefined,
        models: pairs.map(({models, ...props}) => ({
            ...props,
            models: models.map(({model: {id}}) => id)
        }))
    }
}
