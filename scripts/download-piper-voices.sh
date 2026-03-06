#!/bin/bash
# Download all Piper TTS voice models
# Models are downloaded from the official Piper GitHub releases

MODELS_DIR="/root/discord_bots/CertiFriedUtility/piper_models"
BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main"

echo "Starting Piper TTS voice model download..."
echo "Models directory: $MODELS_DIR"

# Create models directory if it doesn't exist
mkdir -p "$MODELS_DIR"

# Function to download a voice model
download_voice() {
    local locale=$1
    local voice=$2
    local quality=$3

    local voice_dir="$MODELS_DIR/$locale/$voice/$quality"
    local model_name="$locale-$voice-$quality"

    # Create directory structure
    mkdir -p "$voice_dir"

    # Check if model already exists
    if [ -f "$voice_dir/${model_name}.onnx" ]; then
        echo "✓ $model_name already exists, skipping..."
        return 0
    fi

    echo "⬇ Downloading $model_name..."

    # Download model file (.onnx)
    wget -q --show-progress -O "$voice_dir/${model_name}.onnx" \
        "$BASE_URL/$locale/$voice/$quality/$locale-$voice-$quality.onnx"

    # Download config file (.onnx.json)
    wget -q --show-progress -O "$voice_dir/${model_name}.onnx.json" \
        "$BASE_URL/$locale/$voice/$quality/$locale-$voice-$quality.onnx.json"

    if [ $? -eq 0 ]; then
        echo "✓ Successfully downloaded $model_name"
    else
        echo "✗ Failed to download $model_name"
        return 1
    fi
}

# Download all voices from AVAILABLE_VOICES
# US English
download_voice "en_US" "amy" "medium"
download_voice "en_US" "joe" "medium"
download_voice "en_US" "ryan" "high"
download_voice "en_US" "ljspeech" "high"
download_voice "en_US" "danny" "low"
download_voice "en_US" "kathleen" "low"
download_voice "en_US" "john" "medium"
download_voice "en_US" "bryce" "medium"
download_voice "en_US" "kristin" "medium"
download_voice "en_US" "norman" "medium"
download_voice "en_US" "kusal" "medium"
download_voice "en_US" "hfc_female" "medium"
download_voice "en_US" "hfc_male" "medium"
download_voice "en_US" "lessac" "medium"
download_voice "en_US" "libritts" "high"
download_voice "en_US" "arctic" "medium"
download_voice "en_US" "l2arctic" "medium"

# British English
download_voice "en_GB" "alan" "medium"
download_voice "en_GB" "alba" "medium"
download_voice "en_GB" "aru" "medium"
download_voice "en_GB" "jenny" "medium"
download_voice "en_GB" "cori" "medium"
download_voice "en_GB" "northern_english_male" "medium"
download_voice "en_GB" "southern_english_female" "medium"
download_voice "en_GB" "vctk" "medium"
download_voice "en_GB" "semaine" "medium"

# Arabic
download_voice "ar_JO" "arabic_male" "medium"

# Catalan
download_voice "ca_ES" "catalan_female" "medium"

# Czech
download_voice "cs_CZ" "czech_female" "medium"

# Danish
download_voice "da_DK" "danish_female" "medium"

# German
download_voice "de_DE" "thorsten" "medium"
download_voice "de_DE" "eva_k" "medium"

# Greek
download_voice "el_GR" "greek_male" "medium"

# Spanish (Spain)
download_voice "es_ES" "carlfm" "medium"
download_voice "es_ES" "mls_9972" "medium"

# Spanish (Mexico)
download_voice "es_MX" "mexican_male" "medium"

# Finnish
download_voice "fi_FI" "finnish_male" "medium"

# French
download_voice "fr_FR" "siwis" "medium"
download_voice "fr_FR" "tom" "medium"

# Hungarian
download_voice "hu_HU" "hungarian_female" "medium"

# Icelandic
download_voice "is_IS" "icelandic_male" "medium"

# Italian
download_voice "it_IT" "riccardo" "medium"

# Japanese
download_voice "ja_JP" "japanese_female" "medium"

# Georgian
download_voice "ka_GE" "georgian_female" "medium"

# Kazakh
download_voice "kk_KZ" "kazakh_female" "medium"

# Korean
download_voice "ko_KR" "korean_female" "medium"

# Luxembourgish
download_voice "lb_LU" "luxembourgish_male" "medium"

# Nepali
download_voice "ne_NP" "nepali_male" "medium"

# Dutch
download_voice "nl_NL" "dutch_male" "medium"
download_voice "nl_NL" "dutch_female" "medium"

# Norwegian
download_voice "no_NO" "norwegian_female" "medium"

# Polish
download_voice "pl_PL" "polish_male" "medium"
download_voice "pl_PL" "polish_female" "medium"

# Portuguese (Brazil)
download_voice "pt_BR" "faber" "medium"

# Portuguese (Portugal)
download_voice "pt_PT" "tugao" "medium"

# Romanian
download_voice "ro_RO" "romanian_female" "medium"

# Russian
download_voice "ru_RU" "russian_male" "medium"
download_voice "ru_RU" "russian_female" "medium"

# Slovak
download_voice "sk_SK" "slovak_female" "medium"

# Slovenian
download_voice "sl_SI" "slovenian_male" "medium"

# Serbian
download_voice "sr_RS" "serbian_male" "medium"

# Swedish
download_voice "sv_SE" "swedish_male" "medium"

# Swahili
download_voice "sw_CD" "swahili_male" "medium"

# Turkish
download_voice "tr_TR" "turkish_male" "medium"

# Ukrainian
download_voice "uk_UA" "ukrainian_female" "medium"

# Vietnamese
download_voice "vi_VN" "vietnamese_male" "medium"
download_voice "vi_VN" "vietnamese_female" "medium"

# Chinese
download_voice "zh_CN" "chinese_female" "medium"

echo ""
echo "====================================="
echo "Voice model download complete!"
echo "====================================="
echo "Total voices installed:"
find "$MODELS_DIR" -name "*.onnx" | wc -l
