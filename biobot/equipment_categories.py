"""Editable equipment families, inferred from capabilities for older profiles."""
import re

# These labels organize the catalog; they never restrict supported instruments.
CAPABILITY_CATEGORIES = {
    'Liquid handling': r'liquid[\s_-]+handl|pipett|dispens|acoustic[\s_-]+(?:droplet[\s_-]+)?(?:eject|transfer)|(?:liquid|fluid)[\s_-]+transfer',
    'Imaging & microscopy': r'imag|microscop|camera',
    'Analysis & detection': r'(?:analyte|assay|sample|signal|molecular|optical)[\s_-]+detect|detect(?:ion)?[\s_-]+(?:of[\s_-]+)?(?:analyte|sample|signal)|spectro|fluorescen|absorbance|plate.read|measurement|sequenc|cytometr',
    'Separation & purification': r'chromatograph|purif|electrophores|filtrat|extract',
    'Centrifugation': r'centrifug',
    'Thermal processing': r'thermocycl|thermal.cycl|\bpcr\b|heating|cooling|temperature.control',
    'Mixing & incubation': r'mixing|shak|stirr|incubat',
    'Cultivation & bioprocessing': r'cultivat|bioreactor|ferment|cell.cultur',
    'Sample transport & positioning': r'plate.handl|sample.transport|robotic.arm|positioning|motorized.stage',
    'Fluid control': r'microfluid|fluid.control|pump|valve',
    'Fabrication': r'bioprint|3d.print|fabricat',
}


def clean_categories(values):
    if not isinstance(values, list) or len(values) > 20 or any(
        not isinstance(value, str) or not 1 <= len(value.strip()) <= 80 for value in values
    ):
        raise ValueError('Categories must be a list of up to 20 names, each 1–80 characters.')
    result, seen = [], set()
    for value in values:
        label = ' '.join(value.split())
        label = next((known for known in CAPABILITY_CATEGORIES if known.casefold() == label.casefold()), label)
        if label.casefold() not in seen:
            seen.add(label.casefold())
            result.append(label)
    return result


def categories_for(profile):
    if 'categories' in profile:
        return clean_categories(profile['categories'])
    # Use recorded capabilities and interfaces, never brand names or physical model identity.
    features = profile.get('features', [])
    evidence = ' '.join(value for value in features if isinstance(value, str)).casefold() if isinstance(features, list) else ''
    interface = profile.get('programming_interface')
    if isinstance(interface, str):
        evidence += ' ' + interface.casefold()
    return [label for label, pattern in CAPABILITY_CATEGORIES.items() if re.search(pattern, evidence)]


def require_discovered_categories(profile):
    """Catalog builders must classify drafts; explicit administrator edits stay authoritative."""
    documented = {key: value for key, value in profile.items() if key != 'categories'}
    inferred = categories_for(documented)
    supplied = clean_categories(profile.get('categories', []))
    categories = clean_categories(supplied + [label for label in inferred if label not in supplied])
    categories = [label for label in categories if label.casefold() not in {'uncategorized', 'unclassified', 'unknown', 'other'}]
    if not categories:
        raise ValueError('Discovery did not establish an equipment category from documented capabilities. Retry discovery to complete this entry.')
    return {**profile, 'categories': categories}
