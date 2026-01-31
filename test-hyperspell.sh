#!/bin/bash
# Hyperspell Cache Testing Script
# This script tests if Hyperspell semantic caching is working

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load .env file if it exists
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Configuration
SUPABASE_URL="${VITE_SUPABASE_URL:-your-project.supabase.co}"
ANON_KEY="${VITE_SUPABASE_PUBLISHABLE_KEY:-your-anon-key}"

# Validate configuration
if [ "$SUPABASE_URL" = "your-project.supabase.co" ] || [ "$SUPABASE_URL" = "https://your-project.supabase.co" ]; then
    echo -e "${RED}Error: SUPABASE_URL not configured${NC}"
    echo -e "${YELLOW}Please set VITE_SUPABASE_URL in your .env file${NC}"
    exit 1
fi

if [ "$ANON_KEY" = "your-anon-key" ]; then
    echo -e "${RED}Error: ANON_KEY not configured${NC}"
    echo -e "${YELLOW}Please set VITE_SUPABASE_PUBLISHABLE_KEY in your .env file${NC}"
    exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Hyperspell Cache Testing Script${NC}"
echo -e "${BLUE}========================================${NC}\n"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}Warning: jq not installed. Install with: brew install jq${NC}"
    echo -e "${YELLOW}Continuing without pretty formatting...${NC}\n"
    JQ_CMD="cat"
else
    JQ_CMD="jq"
fi

# Function to make API call and extract fromCache value
test_claim() {
    local test_name=$1
    local claim=$2
    local expected_cache=$3

    echo -e "${BLUE}Test: ${test_name}${NC}"
    echo -e "Claim: \"${claim}\""

    # Measure time and make request
    start_time=$(date +%s%N)

    # Remove https:// prefix if present
    CLEAN_URL="${SUPABASE_URL#https://}"

    response=$(curl -s -X POST \
        "https://${CLEAN_URL}/functions/v1/fact-check" \
        -H "apikey: ${ANON_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"claim\": \"${claim}\"}")
    end_time=$(date +%s%N)

    # Calculate elapsed time in milliseconds
    elapsed_ms=$(( (end_time - start_time) / 1000000 ))

    # Extract fromCache value
    from_cache=$(echo "$response" | jq -r '.fromCache // "null"' 2>/dev/null || echo "error")

    # Check for errors
    error=$(echo "$response" | jq -r '.error // "null"' 2>/dev/null || echo "null")

    if [ "$error" != "null" ]; then
        echo -e "${RED}❌ Error: ${error}${NC}"
        echo -e "Response: $response\n"
        return 1
    fi

    # Display results
    echo -e "Response time: ${elapsed_ms}ms"
    echo -e "fromCache: ${from_cache}"

    # Validate against expected result
    if [ "$from_cache" == "$expected_cache" ]; then
        if [ "$expected_cache" == "true" ]; then
            if [ $elapsed_ms -lt 500 ]; then
                echo -e "${GREEN}✅ PASS - Cache hit and fast response!${NC}\n"
            else
                echo -e "${YELLOW}⚠️  PARTIAL - Cache hit but slow (${elapsed_ms}ms)${NC}\n"
            fi
        else
            if [ $elapsed_ms -gt 1000 ]; then
                echo -e "${GREEN}✅ PASS - Cache miss with expected slow response${NC}\n"
            else
                echo -e "${YELLOW}⚠️  PARTIAL - Cache miss but unexpectedly fast${NC}\n"
            fi
        fi
    else
        echo -e "${RED}❌ FAIL - Expected fromCache: ${expected_cache}, got: ${from_cache}${NC}\n"
    fi

    # Small delay between tests
    sleep 1
}

echo -e "${YELLOW}Testing with Supabase URL: ${SUPABASE_URL}${NC}\n"

# Test 1: First claim (should be cache miss)
test_claim \
    "Cache Miss - First Time Claim" \
    "The unemployment rate is 4.2 percent" \
    "false"

# Test 2: Exact same claim (should be cache hit)
test_claim \
    "Cache Hit - Exact Same Claim" \
    "The unemployment rate is 4.2 percent" \
    "true"

# Test 3: Semantically similar (should be cache hit)
test_claim \
    "Cache Hit - Semantic Match" \
    "Unemployment is at 4.2%" \
    "true"

# Test 4: Another variation (should be cache hit)
test_claim \
    "Cache Hit - Another Variation" \
    "The current unemployment rate stands at 4.2 percent" \
    "true"

# Test 5: Completely different claim (should be cache miss)
test_claim \
    "Cache Miss - New Claim" \
    "Inflation is at 9 percent" \
    "false"

# Test 6: Repeat new claim (should be cache hit)
test_claim \
    "Cache Hit - Repeat New Claim" \
    "Inflation is at 9 percent" \
    "true"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Testing Complete!${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${YELLOW}Check your Supabase logs for 'Cache hit' messages:${NC}"
echo -e "Dashboard → Edge Functions → fact-check → Logs\n"

echo -e "${GREEN}Expected log messages:${NC}"
echo -e "- Test 2-4, 6: Should show 'Cache hit for claim: ...'"
echo -e "- Test 1, 5: No cache messages (first time seeing claim)\n"
