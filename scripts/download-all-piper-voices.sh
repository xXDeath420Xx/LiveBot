#!/bin/bash
# Download all Piper TTS voice models one language at a time
# Using the Hugging Face repository structure

MODELS_DIR="/root/discord_bots/CertiFriedUtility/piper_models"
BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main"
LOG_FILE="/tmp/piper-download.log"

echo "========================================"
echo "Piper TTS Voice Pack Installer"
echo "========================================"
echo "Target directory: $MODELS_DIR"
echo "Log file: $LOG_FILE"
echo ""

# Download a single voice model
download_voice() {
    local iso_code=$1
    local locale=$2
    local voice=$3
    local quality=$4

    local voice_dir="$MODELS_DIR/$locale/$voice/$quality"
    local model_name="$locale-$voice-$quality"

    # Check if already exists
    if [ -f "$voice_dir/${model_name}.onnx" ] && [ -s "$voice_dir/${model_name}.onnx" ]; then
        echo "  ✓ $model_name already exists"
        return 0
    fi

    # Create directory
    mkdir -p "$voice_dir"

    echo "  ⬇ Downloading $model_name..."

    # Download .onnx file
    if wget -q --show-progress --timeout=60 -O "$voice_dir/${model_name}.onnx" \
        "$BASE_URL/$iso_code/$locale/$voice/$quality/${model_name}.onnx" 2>&1 | tee -a "$LOG_FILE"; then

        # Download .onnx.json config file
        wget -q --timeout=30 -O "$voice_dir/${model_name}.onnx.json" \
            "$BASE_URL/$iso_code/$locale/$voice/$quality/${model_name}.onnx.json" 2>&1 | tee -a "$LOG_FILE"

        echo "  ✓ Downloaded $model_name"
        return 0
    else
        echo "  ✗ Failed to download $model_name" | tee -a "$LOG_FILE"
        rm -f "$voice_dir/${model_name}.onnx" "$voice_dir/${model_name}.onnx.json"
        return 1
    fi
}

# Arabic
echo "[1/35] Arabic..."
download_voice "ar" "ar_JO" "kareem" "medium"

# Bulgarian
echo "[2/35] Bulgarian..."
download_voice "bg" "bg_BG" "jindjova" "medium"

# Catalan
echo "[3/35] Catalan..."
download_voice "ca" "ca_ES" "upc_ona" "medium"
download_voice "ca" "ca_ES" "upc_pau" "medium"

# Czech
echo "[4/35] Czech..."
download_voice "cs" "cs_CZ" "jirka" "medium"

# Welsh
echo "[5/35] Welsh..."
download_voice "cy" "cy_GB" "gwryw_gogleddol" "medium"

# Danish
echo "[6/35] Danish..."
download_voice "da" "da_DK" "talesyntese" "medium"

# German
echo "[7/35] German..."
download_voice "de" "de_DE" "thorsten" "low"
download_voice "de" "de_DE" "thorsten" "medium"
download_voice "de" "de_DE" "thorsten" "high"
download_voice "de" "de_DE" "eva_k" "medium"
download_voice "de" "de_DE" "karlsson" "medium"
download_voice "de" "de_DE" "kerstin" "medium"
download_voice "de" "de_DE" "pavoque" "low"
download_voice "de" "de_DE" "ramona" "low"

# Greek
echo "[8/35] Greek..."
download_voice "el" "el_GR" "rapunzelina" "low"

# Spanish (Spain)
echo "[9/35] Spanish (Spain)..."
download_voice "es" "es_ES" "carlfm" "medium"
download_voice "es" "es_ES" "davefx" "medium"
download_voice "es" "es_ES" "mls_9972" "low"
download_voice "es" "es_ES" "mls_10246" "low"

# Spanish (Mexico)
echo "[10/35] Spanish (Mexico)..."
download_voice "es" "es_MX" "ald" "medium"
download_voice "es" "es_MX" "claude" "high"

# Persian
echo "[11/35] Persian..."
download_voice "fa" "fa_IR" "amir" "medium"
download_voice "fa" "fa_IR" "gyro" "medium"

# Finnish
echo "[12/35] Finnish..."
download_voice "fi" "fi_FI" "harri" "low"
download_voice "fi" "fi_FI" "harri" "medium"

# French
echo "[13/35] French..."
download_voice "fr" "fr_FR" "siwis" "low"
download_voice "fr" "fr_FR" "siwis" "medium"
download_voice "fr" "fr_FR" "tom" "medium"
download_voice "fr" "fr_FR" "upmc" "medium"

# Hindi
echo "[14/35] Hindi..."
download_voice "hi" "hi_IN" "medium" "medium"

# Hungarian
echo "[15/35] Hungarian..."
download_voice "hu" "hu_HU" "anna" "medium"
download_voice "hu" "hu_HU" "berta" "medium"
download_voice "hu" "hu_HU" "imre" "medium"

# Indonesian
echo "[16/35] Indonesian..."
download_voice "id" "id_ID" "fajri" "medium"

# Icelandic
echo "[17/35] Icelandic..."
download_voice "is" "is_IS" "bui" "medium"
download_voice "is" "is_IS" "salka" "medium"
download_voice "is" "is_IS" "steinn" "medium"
download_voice "is" "is_IS" "ugla" "medium"

# Italian
echo "[18/35] Italian..."
download_voice "it" "it_IT" "riccardo" "medium"
download_voice "it" "it_IT" "paola" "medium"

# Georgian
echo "[19/35] Georgian..."
download_voice "ka" "ka_GE" "natia" "medium"

# Kazakh
echo "[20/35] Kazakh..."
download_voice "kk" "kk_KZ" "iseke" "medium"
download_voice "kk" "kk_KZ" "issai" "medium"
download_voice "kk" "kk_KZ" "raya" "medium"

# Luxembourgish
echo "[21/35] Luxembourgish..."
download_voice "lb" "lb_LU" "thorsten" "medium"

# Latvian
echo "[22/35] Latvian..."
download_voice "lv" "lv_LV" "regnars" "medium"

# Malayalam
echo "[23/35] Malayalam..."
download_voice "ml" "ml_IN" "male" "medium"

# Nepali
echo "[24/35] Nepali..."
download_voice "ne" "ne_NP" "google" "medium"

# Dutch
echo "[25/35] Dutch..."
download_voice "nl" "nl_NL" "mls_5809" "low"
download_voice "nl" "nl_NL" "mls_7432" "low"
download_voice "nl" "nl_BE" "nathalie" "medium"
download_voice "nl" "nl_BE" "rdh" "medium"

# Norwegian
echo "[26/35] Norwegian..."
download_voice "no" "no_NO" "talesyntese" "medium"

# Polish
echo "[27/35] Polish..."
download_voice "pl" "pl_PL" "darkman" "medium"
download_voice "pl" "pl_PL" "gosia" "medium"
download_voice "pl" "pl_PL" "mc_speech" "medium"

# Portuguese (Brazil)
echo "[28/35] Portuguese (Brazil)..."
download_voice "pt" "pt_BR" "faber" "medium"
download_voice "pt" "pt_BR" "edresson" "low"

# Portuguese (Portugal)
echo "[29/35] Portuguese (Portugal)..."
download_voice "pt" "pt_PT" "tugao" "medium"

# Romanian
echo "[30/35] Romanian..."
download_voice "ro" "ro_RO" "mihai" "medium"

# Russian
echo "[31/35] Russian..."
download_voice "ru" "ru_RU" "dmitri" "medium"
download_voice "ru" "ru_RU" "irina" "medium"
download_voice "ru" "ru_RU" "ruslan" "medium"

# Slovak
echo "[32/35] Slovak..."
download_voice "sk" "sk_SK" "lili" "medium"

# Slovenian
echo "[33/35] Slovenian..."
download_voice "sl" "sl_SI" "artur" "medium"

# Serbian
echo "[34/35] Serbian..."
download_voice "sr" "sr_RS" "serbski_institut" "medium"

# Swedish
echo "[35/35] Swedish..."
download_voice "sv" "sv_SE" "nst" "medium"

# Swahili
echo "[36/35] Swahili..."
download_voice "sw" "sw_CD" "lanfrica" "medium"

# Telugu
echo "[37/35] Telugu..."
download_voice "te" "te_IN" "female" "medium"

# Turkish
echo "[38/35] Turkish..."
download_voice "tr" "tr_TR" "dfki" "medium"
download_voice "tr" "tr_TR" "fahrettin" "medium"
download_voice "tr" "tr_TR" "fettah" "medium"

# Ukrainian
echo "[39/35] Ukrainian..."
download_voice "uk" "uk_UA" "lada" "medium"
download_voice "uk" "uk_UA" "ukrainian_tts" "medium"

# Vietnamese
echo "[40/35] Vietnamese..."
download_voice "vi" "vi_VN" "25hours_single" "low"
download_voice "vi" "vi_VN" "vais1000" "medium"
download_voice "vi" "vi_VN" "vivos" "medium"

# Chinese
echo "[41/35] Chinese..."
download_voice "zh" "zh_CN" "huayan" "medium"

echo ""
echo "========================================"
echo "Download Complete!"
echo "========================================"
echo ""
echo "Counting installed voice models..."
VOICE_COUNT=$(find "$MODELS_DIR" -name "*.onnx" -type f 2>/dev/null | wc -l)
echo "Total voice models installed: $VOICE_COUNT"
echo "Directory size: $(du -sh $MODELS_DIR | cut -f1)"
echo ""
echo "Log file: $LOG_FILE"
