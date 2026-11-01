import java.math.BigDecimal
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.regex.Pattern

/**
 * Portable strict JSON-Schema subset interpreter (port of conformance/python/strict_schema.py) and a strict
 * RFC 8259 parser. org.json is deliberately not used for evidence: it is lenient (comments, single quotes,
 * unquoted keys) where the other readers are not.
 */
object StrictJson {
    class MalformedJson(message: String) : Exception(message)

    /** Objects are LinkedHashMap<String, Any?>, arrays List, integers Long/BigInteger, other numbers Double. */
    fun parse(bytes: ByteArray): Any? {
        val text = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        } catch (e: CharacterCodingException) {
            throw MalformedJson("invalid UTF-8")
        }
        val p = Parser(text)
        try {
            p.ws()
            val v = p.value()
            p.ws()
            if (p.i != text.length) throw MalformedJson("trailing data")
            return v
        } catch (e: StackOverflowError) {
            throw MalformedJson("nesting")
        }
    }

    private class Parser(val s: String) {
        var i = 0
        fun ws() { while (i < s.length && s[i] in " \t\n\r") i++ }
        fun fail(m: String): Nothing = throw MalformedJson("$m at $i")
        fun value(): Any? {
            if (i >= s.length) fail("eof")
            return when (s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", null)
                else -> num()
            }
        }
        fun lit(word: String, v: Any?): Any? { if (!s.startsWith(word, i)) fail("literal"); i += word.length; return v }
        fun obj(): Map<String, Any?> {
            i++
            val out = LinkedHashMap<String, Any?>()
            ws()
            if (i < s.length && s[i] == '}') { i++; return out }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') fail("key")
                val k = str()
                ws()
                if (i >= s.length || s[i] != ':') fail("colon")
                i++
                ws()
                if (out.containsKey(k)) fail("duplicate key")
                out[k] = value()
                ws()
                if (i < s.length && s[i] == ',') { i++; continue }
                if (i < s.length && s[i] == '}') { i++; return out }
                fail("object")
            }
        }
        fun arr(): List<Any?> {
            i++
            val out = ArrayList<Any?>()
            ws()
            if (i < s.length && s[i] == ']') { i++; return out }
            while (true) {
                ws()
                out.add(value())
                ws()
                if (i < s.length && s[i] == ',') { i++; continue }
                if (i < s.length && s[i] == ']') { i++; return out }
                fail("array")
            }
        }
        fun str(): String {
            i++
            val b = StringBuilder()
            while (true) {
                if (i >= s.length) fail("unterminated string")
                val c = s[i++]
                when {
                    c == '"' -> return b.toString()
                    c.code < 0x20 -> fail("control character")
                    c == '\\' -> {
                        if (i >= s.length) fail("escape")
                        when (val e = s[i++]) {
                            '"' -> b.append('"'); '\\' -> b.append('\\'); '/' -> b.append('/')
                            'b' -> b.append('\b'); 'f' -> b.append('\u000c'); 'n' -> b.append('\n')
                            'r' -> b.append('\r'); 't' -> b.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail("unicode escape")
                                val hex = s.substring(i, i + 4)
                                if (!hex.all { it in "0123456789abcdefABCDEF" }) fail("unicode escape")
                                b.append(hex.toInt(16).toChar()); i += 4
                            }
                            else -> fail("escape $e")
                        }
                    }
                    else -> b.append(c)
                }
            }
        }
        fun num(): Any {
            val start = i
            if (i < s.length && s[i] == '-') i++
            if (i < s.length && s[i] == '0') i++
            else if (i < s.length && s[i] in '1'..'9') while (i < s.length && s[i].isAsciiDigit()) i++
            else fail("number")
            var integral = true
            if (i < s.length && s[i] == '.') {
                integral = false; i++
                if (i >= s.length || !s[i].isAsciiDigit()) fail("fraction")
                while (i < s.length && s[i].isAsciiDigit()) i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                integral = false; i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (i >= s.length || !s[i].isAsciiDigit()) fail("exponent")
                while (i < s.length && s[i].isAsciiDigit()) i++
            }
            val tok = s.substring(start, i)
            if (integral) {
                val big = BigInteger(tok)
                if (big.toDouble().isInfinite()) fail("number overflows a double")
                return if (big.bitLength() < 64) big.toLong() else big
            }
            val d = tok.toDouble()
            if (d.isInfinite() || d.isNaN()) fail("number overflows a double")
            return d
        }
        private fun Char.isAsciiDigit() = this in '0'..'9'
    }
}

class SchemaUnsupported(message: String) : Exception(message)

class StrictSchema(private val root: Map<String, Any?>) {
    private val patterns = HashMap<String, Pattern>()

    init { check(root, "#") }

    companion object {
        val SUPPORTED = setOf(
            "\$schema", "\$id", "\$defs", "\$ref", "title", "description", "type", "const", "enum", "required",
            "properties", "additionalProperties", "propertyNames", "minProperties", "maxProperties", "items",
            "minItems", "maxItems", "pattern", "minLength", "maxLength", "minimum", "maximum", "anyOf", "allOf",
            "if", "then",
        )
        val TYPES = setOf("object", "array", "string", "integer", "number", "boolean", "null")
        private fun isNumber(v: Any?) = v is Long || v is Int || v is Double || v is BigInteger
        private fun dec(v: Any?): BigDecimal = when (v) {
            is Long -> BigDecimal.valueOf(v)
            is Int -> BigDecimal.valueOf(v.toLong())
            is BigInteger -> BigDecimal(v)
            is Double -> BigDecimal(v)
            else -> error("not a number")
        }

        fun token(key: Any): String {
            if (key is Int) return key.toString()
            val sb = StringBuilder()
            for (b in (key as String).toByteArray(Charsets.UTF_8)) {
                val u = b.toInt() and 0xff
                val ch = u.toChar()
                if (u < 0x80 && (ch.isLetterOrDigit() || ch in "._-")) sb.append(ch) else sb.append("%%%02X".format(u))
            }
            return sb.toString()
        }

        fun isType(v: Any?, t: String): Boolean = when (t) {
            "null" -> v == null
            "boolean" -> v is Boolean
            "string" -> v is String
            "array" -> v is List<*>
            "object" -> v is Map<*, *>
            "number" -> isNumber(v)
            "integer" -> v is Long || v is Int || v is BigInteger || (v is Double && v.isFinite() && v == Math.floor(v))
            else -> throw SchemaUnsupported(t)
        }

        fun jsonEqual(a: Any?, b: Any?): Boolean {
            if (a is Boolean || b is Boolean) return a is Boolean && b is Boolean && a == b
            if (isNumber(a) && isNumber(b)) return dec(a).compareTo(dec(b)) == 0
            if (a == null || b == null) return a == null && b == null
            if (a is String || b is String) return a is String && b is String && a == b
            if (a is List<*> && b is List<*>) return a.size == b.size && a.indices.all { jsonEqual(a[it], b[it]) }
            if (a is Map<*, *> && b is Map<*, *>) return a.size == b.size && a.keys.all { b.containsKey(it) && jsonEqual(a[it], b[it]) }
            return false
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun m(x: Any?) = x as Map<String, Any?>
    private fun isCount(v: Any?) = (v is Long && v >= 0) || (v is Int && v >= 0)

    private fun check(s: Any?, where: String) {
        fun fail(msg: String): Nothing = throw SchemaUnsupported("$where: $msg")
        if (s !is Map<*, *>) fail("schema must be an object")
        val sm = m(s)
        for (k in sm.keys) {
            if (k !in SUPPORTED) fail("unsupported keyword $k")
            if (k == "\$defs" && where != "#") fail("\$defs only at the root")
        }
        (sm["\$defs"] as? Map<*, *>)?.forEach { (n, sub) -> check(sub, "$where/\$defs/$n") }
        if ("\$ref" in sm) {
            val r = sm["\$ref"]
            val defs = root["\$defs"] as? Map<*, *>
            if (r !is String || !r.startsWith("#/\$defs/") || defs == null || !defs.containsKey(r.substring(8))) fail("unresolvable or non-local \$ref $r")
        }
        if ("type" in sm) {
            val t = sm["type"]
            val ts = if (t is List<*>) t else listOf(t)
            if (ts.isEmpty() || ts.any { it !in TYPES }) fail("type")
        }
        if ("enum" in sm && !(sm["enum"] is List<*> && (sm["enum"] as List<*>).isNotEmpty())) fail("enum must be a non-empty array")
        if ("required" in sm && !(sm["required"] is List<*> && (sm["required"] as List<*>).all { it is String })) fail("required must be a string array")
        if ("pattern" in sm) {
            val p = sm["pattern"]
            if (p !is String || !p.startsWith("^") || !p.endsWith("$") || p.any { it.code > 0x7f }) fail("pattern must be an anchored ASCII ^...\$ expression")
            patterns[p] = Pattern.compile(p)
        }
        for (k in listOf("minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength")) if (k in sm && !isCount(sm[k])) fail("$k must be a non-negative integer")
        for (k in listOf("minimum", "maximum")) if (k in sm && !isNumber(sm[k])) fail("$k must be a number")
        if ("properties" in sm) {
            val props = sm["properties"] as? Map<*, *> ?: fail("properties must be an object")
            props.forEach { (n, sub) -> check(sub, "$where/properties/$n") }
        }
        if ("additionalProperties" in sm && sm["additionalProperties"] != false) check(sm["additionalProperties"], "$where/additionalProperties")
        for (k in listOf("propertyNames", "items", "if", "then")) if (k in sm) check(sm[k], "$where/$k")
        if ("then" in sm && "if" !in sm) fail("then without if")
        for (k in listOf("anyOf", "allOf")) if (k in sm) {
            val list = sm[k] as? List<*>
            if (list == null || list.isEmpty()) fail("$k must be a non-empty array")
            list.forEachIndexed { i, sub -> check(sub, "$where/$k/$i") }
        }
    }

    fun validate(instance: Any?): List<String> {
        val out = HashSet<String>()
        v(root, instance, "", out)
        return out.sorted()
    }

    private fun valid(s: Map<String, Any?>, x: Any?): Boolean {
        val out = HashSet<String>()
        v(s, x, "", out)
        return out.isEmpty()
    }

    private fun v(s: Map<String, Any?>, x: Any?, path: String, out: MutableSet<String>) {
        fun err(kw: String) = out.add("$path:$kw")
        if ("\$ref" in s) v(m(m(root["\$defs"])[(s["\$ref"] as String).substring(8)]), x, path, out)
        if ("type" in s) {
            val t = s["type"]
            val ts = if (t is List<*>) t else listOf(t)
            if (ts.none { isType(x, it as String) }) err("type")
        }
        if ("const" in s && !jsonEqual(x, s["const"])) err("const")
        if ("enum" in s && (s["enum"] as List<*>).none { jsonEqual(x, it) }) err("enum")
        if (x is String) {
            val n = x.codePointCount(0, x.length)
            if ("minLength" in s && n < (s["minLength"] as Number).toLong()) err("minLength")
            if ("maxLength" in s && n > (s["maxLength"] as Number).toLong()) err("maxLength")
            if ("pattern" in s && !patterns.getValue(s["pattern"] as String).matcher(x).matches()) err("pattern")
        }
        if (isNumber(x)) {
            if ("minimum" in s && dec(x) < dec(s["minimum"])) err("minimum")
            if ("maximum" in s && dec(x) > dec(s["maximum"])) err("maximum")
        }
        if (x is List<*>) {
            if ("minItems" in s && x.size < (s["minItems"] as Number).toLong()) err("minItems")
            if ("maxItems" in s && x.size > (s["maxItems"] as Number).toLong()) err("maxItems")
            if ("items" in s) x.forEachIndexed { i, item -> v(m(s["items"]), item, "$path/$i", out) }
        }
        if (x is Map<*, *>) {
            if ("required" in s && (s["required"] as List<*>).any { !x.containsKey(it) }) err("required")
            if ("minProperties" in s && x.size < (s["minProperties"] as Number).toLong()) err("minProperties")
            if ("maxProperties" in s && x.size > (s["maxProperties"] as Number).toLong()) err("maxProperties")
            val props = (s["properties"] as? Map<*, *>) ?: emptyMap<String, Any?>()
            for ((k, value) in x) if (props.containsKey(k)) v(m(props[k]), value, "$path/${token(k as String)}", out)
            if ("additionalProperties" in s) {
                val extra = x.keys.filter { !props.containsKey(it) }
                val ap = s["additionalProperties"]
                if (ap == false) { if (extra.isNotEmpty()) err("additionalProperties") }
                else for (k in extra) v(m(ap), x[k], "$path/${token(k as String)}", out)
            }
            if ("propertyNames" in s) for (k in x.keys) v(m(s["propertyNames"]), k, path, out)
        }
        if ("allOf" in s) for (sub in s["allOf"] as List<*>) v(m(sub), x, path, out)
        if ("anyOf" in s && (s["anyOf"] as List<*>).none { valid(m(it), x) }) err("anyOf")
        if ("if" in s && "then" in s && valid(m(s["if"]), x)) v(m(s["then"]), x, path, out)
    }
}
